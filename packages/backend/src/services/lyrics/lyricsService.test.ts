import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { LyricsModel } from '../../models/Lyrics';
import { TrackModel } from '../../models/Track';
import { getLyricsForTrack } from './lyricsService';
import type { LyricsProvider } from './LyricsProvider';
import type { Lyrics } from '@syra/shared-types';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const TRACK_ID = new (require('mongoose').Types.ObjectId)().toString();

// ── Fake provider helpers ─────────────────────────────────────────────────────

function makeProvider(
  result: Omit<Lyrics, 'trackId' | 'updatedAt'> | null,
): LyricsProvider & { callCount: number; lastQuery: unknown } {
  const p = {
    source: 'lrclib',
    callCount: 0,
    lastQuery: null as unknown,
    async getLyrics(query: unknown) {
      p.callCount += 1;
      p.lastQuery = query;
      return result;
    },
  };
  return p as LyricsProvider & { callCount: number; lastQuery: unknown };
}

function throwingProvider(): LyricsProvider {
  return {
    source: 'lrclib',
    async getLyrics() { throw new Error('provider should not be called'); },
  };
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedCachedLyrics(trackId: string) {
  return LyricsModel.create({
    trackId,
    synced: true,
    lines: [{ timeMs: 1000, text: 'cached line' }],
    source: 'lrclib',
  });
}

async function seedTrack(trackId: string) {
  return TrackModel.create({
    _id: trackId,
    title: 'Open Road',
    artistName: 'Free Artist',
    artistId: new (require('mongoose').Types.ObjectId)(),
    duration: 210,
    albumName: 'Open Album',
    source: 'cc',
    status: 'ready',
    isExplicit: false,
    isAvailable: true,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getLyricsForTrack — cache hit', () => {
  it('returns cached doc without invoking the provider', async () => {
    await seedCachedLyrics(TRACK_ID);

    const provider = throwingProvider();
    const result = await getLyricsForTrack(TRACK_ID, provider);

    expect(result).not.toBeNull();
    expect(result?.trackId).toBe(TRACK_ID);
    expect(result?.lines[0].text).toBe('cached line');
  });
});

describe('getLyricsForTrack — cache miss', () => {
  it('fetches from provider, persists a Lyrics doc, and returns it', async () => {
    await seedTrack(TRACK_ID);

    const provider = makeProvider({
      synced: true,
      lines: [{ timeMs: 0, text: 'hi' }],
      source: 'lrclib',
    });

    const result = await getLyricsForTrack(TRACK_ID, provider);

    expect(result).not.toBeNull();
    expect(result?.trackId).toBe(TRACK_ID);
    expect(result?.synced).toBe(true);
    expect(result?.lines[0].text).toBe('hi');
    expect(result?.source).toBe('lrclib');

    // Exactly one doc persisted
    expect(await LyricsModel.countDocuments({ trackId: TRACK_ID })).toBe(1);
  });

  it('passes trackName, artistName, albumName, durationSec from the track to the provider', async () => {
    await seedTrack(TRACK_ID);

    const provider = makeProvider({
      synced: false,
      lines: [],
      source: 'lrclib',
    });

    await getLyricsForTrack(TRACK_ID, provider);

    expect(provider.callCount).toBe(1);
    const q = provider.lastQuery as Record<string, unknown>;
    expect(q.trackName).toBe('Open Road');
    expect(q.artistName).toBe('Free Artist');
    expect(q.albumName).toBe('Open Album');
    expect(q.durationSec).toBe(210);
  });

  it('returns null and creates no doc when track does not exist', async () => {
    const provider = throwingProvider();
    const result = await getLyricsForTrack(TRACK_ID, provider);

    expect(result).toBeNull();
    expect(await LyricsModel.countDocuments()).toBe(0);
  });

  it('returns null and creates no doc when provider returns null (no lyrics found)', async () => {
    await seedTrack(TRACK_ID);

    const provider = makeProvider(null);
    const result = await getLyricsForTrack(TRACK_ID, provider);

    expect(result).toBeNull();
    expect(await LyricsModel.countDocuments()).toBe(0);
  });

  it('re-running with same trackId hits cache on second call (upsert dedup)', async () => {
    await seedTrack(TRACK_ID);

    const provider = makeProvider({ synced: false, lines: [], source: 'lrclib' });
    await getLyricsForTrack(TRACK_ID, provider);
    await getLyricsForTrack(TRACK_ID, provider); // second call should hit cache

    expect(provider.callCount).toBe(1); // provider only called once
    expect(await LyricsModel.countDocuments({ trackId: TRACK_ID })).toBe(1);
  });
});
