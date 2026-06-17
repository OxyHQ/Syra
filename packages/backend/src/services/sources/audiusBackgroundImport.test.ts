import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { TrackModel } from '../../models/Track';
import { ArtistModel } from '../../models/Artist';
import { AlbumModel } from '../../models/Album';
import { runAudiusImport, enqueueAudiusImport } from './audiusBackgroundImport';
import type { AlbumFetcher } from './audiusBackgroundImport';
import type { ExternalAlbum, ExternalTrack } from '@syra/shared-types';
import type { MusicSourceConnector } from './MusicSourceConnector';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTrack(id: string, artistId = 'artist-1'): ExternalTrack {
  return {
    provider: 'audius',
    externalId: id,
    title: `Track ${id}`,
    artists: [{ name: `Artist ${artistId}`, externalId: artistId }],
    durationSec: 180,
    streamUrl: `https://audius.co/v1/tracks/${id}/stream?app_name=Syra`,
  };
}

function makeConnector(tracks: ExternalTrack[]): MusicSourceConnector {
  return {
    provider: 'audius' as const,
    search: async () => tracks,
  };
}

/** Album fetcher mock that returns the given albums keyed by artist external id. */
function makeAlbumFetcher(byArtist: Record<string, ExternalAlbum[]>): AlbumFetcher {
  return {
    fetchArtistAlbums: async (artistExternalId: string) => byArtist[artistExternalId] ?? [],
  };
}

function makeAlbum(
  externalId: string,
  trackExternalIds: string[],
  tracks?: ExternalTrack[],
): ExternalAlbum {
  return {
    name: `Album ${externalId}`,
    externalId,
    releaseDate: '2021-01-01T00:00:00Z',
    genre: 'Electronic',
    images: [{ url: `https://cdn.audius.co/${externalId}/1000x1000.jpg`, width: 1000, height: 1000 }],
    popularity: { playCount: 1000 },
    trackExternalIds,
    ...(tracks ? { tracks } : {}),
  };
}

// ── runAudiusImport ───────────────────────────────────────────────────────────

describe('runAudiusImport', () => {
  it('imports all tracks + artists returned by connector', async () => {
    const connector = makeConnector([makeTrack('t1'), makeTrack('t2')]);
    const result = await runAudiusImport('jazz', { connector });

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(false);

    const trackCount = await TrackModel.countDocuments({ 'externalIds.audiusId': { $in: ['t1', 't2'] } });
    expect(trackCount).toBe(2);

    const artistCount = await ArtistModel.countDocuments({ 'externalIds.audiusId': 'artist-1' });
    expect(artistCount).toBe(1);
  });

  it('imported tracks have status ready and streamUrl set', async () => {
    const connector = makeConnector([makeTrack('t3')]);
    await runAudiusImport('rock', { connector });

    const track = await TrackModel.findOne({ 'externalIds.audiusId': 't3' });
    expect(track?.status).toBe('ready');
    expect(track?.streamUrl).toBeTruthy();
  });

  it('throttle: skips same query within TTL window', async () => {
    let nowMs = 0;
    const connector = makeConnector([makeTrack('t4')]);

    // First call at t=0 — should run
    const first = await runAudiusImport('pop', { connector, now: () => nowMs });
    expect(first.skipped).toBe(false);
    expect(first.imported).toBe(1);

    // Same query at t=1ms (well within TTL) — should skip
    nowMs = 1;
    const second = await runAudiusImport('pop', { connector, now: () => nowMs });
    expect(second.skipped).toBe(true);
    expect(second.imported).toBe(0);

    // Catalog count unchanged (no second import)
    const count = await TrackModel.countDocuments({ 'externalIds.audiusId': 't4' });
    expect(count).toBe(1);
  });

  it('throttle: normalizes query (trim + lowercase)', async () => {
    let nowMs = 0;
    const connector = makeConnector([makeTrack('t5')]);

    await runAudiusImport('Jazz', { connector, now: () => nowMs });
    nowMs = 1;
    // Identical query in a different case/with spaces — should still be throttled
    const result = await runAudiusImport('  jazz  ', { connector, now: () => nowMs });
    expect(result.skipped).toBe(true);
  });

  it('throttle: runs again once TTL has elapsed', async () => {
    const AUDIUS_IMPORT_TTL_MS = 10 * 60 * 1000;
    let nowMs = 0;
    const connector = makeConnector([makeTrack('t6')]);

    await runAudiusImport('blues', { connector, now: () => nowMs });

    nowMs = AUDIUS_IMPORT_TTL_MS + 1;
    const result = await runAudiusImport('blues', { connector, now: () => nowMs });
    expect(result.skipped).toBe(false);
  });

  it('per-track isolation: one bad track does not abort others', async () => {
    const good = makeTrack('t7');
    const bad: ExternalTrack = {
      ...makeTrack('t8'),
      // Missing artists[0].name — upsertArtist will throw due to empty name issues
      // We'll use an empty externalId which upsertTrack will choke on
      artists: [],
    };

    const connector = makeConnector([good, bad]);
    const result = await runAudiusImport('metal', { connector });

    // Good track imported, bad one skipped — imported count reflects successes
    expect(result.imported).toBe(1);
    const track = await TrackModel.findOne({ 'externalIds.audiusId': 't7' });
    expect(track).not.toBeNull();
  });
});

// ── album sync ──────────────────────────────────────────────────────────────

describe('runAudiusImport — album sync', () => {
  it('syncs albums for each unique imported artist and links member tracks', async () => {
    const connector = makeConnector([
      makeTrack('t1', 'artist-1'),
      makeTrack('t2', 'artist-1'),
    ]);
    const albumFetcher = makeAlbumFetcher({
      'artist-1': [makeAlbum('alb-1', ['t1', 't2'])],
    });

    const result = await runAudiusImport('album-sync-jazz', { connector, albumFetcher });

    expect(result.imported).toBe(2);
    expect(result.albumsSynced).toBe(1);

    const album = await AlbumModel.findOne({ 'externalIds.audiusId': 'alb-1' });
    expect(album).not.toBeNull();
    expect(album?.totalTracks).toBe(2);

    // member tracks linked to the album
    const albumId = album?._id.toString();
    const linked = await TrackModel.countDocuments({ albumId });
    expect(linked).toBe(2);
  });

  it('imports album member tracks that were not in the original search results', async () => {
    const connector = makeConnector([makeTrack('search-track', 'artist-1')]);
    const albumOnlyTrack = makeTrack('album-only-track', 'artist-1');
    const albumFetcher = makeAlbumFetcher({
      'artist-1': [makeAlbum('alb-full', ['album-only-track'], [albumOnlyTrack])],
    });

    const result = await runAudiusImport('album-full-sync', { connector, albumFetcher });

    expect(result.imported).toBe(1);
    expect(result.albumsSynced).toBe(1);

    const album = await AlbumModel.findOne({ 'externalIds.audiusId': 'alb-full' });
    expect(album).not.toBeNull();
    expect(album?.totalTracks).toBe(1);

    const albumTrack = await TrackModel.findOne({ 'externalIds.audiusId': 'album-only-track' });
    expect(albumTrack).not.toBeNull();
    expect(albumTrack?.albumId).toBe(album?._id.toString());
  });

  it('fetches albums once per unique artist, not once per track', async () => {
    const calls: string[] = [];
    const albumFetcher: AlbumFetcher = {
      fetchArtistAlbums: async (id: string) => {
        calls.push(id);
        return [];
      },
    };
    const connector = makeConnector([
      makeTrack('t1', 'artist-1'),
      makeTrack('t2', 'artist-1'),
      makeTrack('t3', 'artist-2'),
    ]);

    await runAudiusImport('album-sync-rock', { connector, albumFetcher });

    expect(calls.sort()).toEqual(['artist-1', 'artist-2']);
  });

  it('caps the number of artists processed per pass', async () => {
    const calls: string[] = [];
    const albumFetcher: AlbumFetcher = {
      fetchArtistAlbums: async (id: string) => {
        calls.push(id);
        return [];
      },
    };
    const tracks = Array.from({ length: 30 }, (_, i) => makeTrack(`t${i}`, `artist-${i}`));
    const connector = makeConnector(tracks);

    await runAudiusImport('album-sync-pop', { connector, albumFetcher, maxArtistsForAlbums: 5 });

    expect(calls.length).toBe(5);
  });

  it('an album-fetch failure for one artist does not abort the import', async () => {
    const albumFetcher: AlbumFetcher = {
      fetchArtistAlbums: async (id: string) => {
        if (id === 'artist-1') throw new Error('boom');
        return [makeAlbum('alb-2', ['t2'])];
      },
    };
    const connector = makeConnector([
      makeTrack('t1', 'artist-1'),
      makeTrack('t2', 'artist-2'),
    ]);

    const result = await runAudiusImport('album-sync-metal', { connector, albumFetcher });

    expect(result.imported).toBe(2);
    expect(result.albumsSynced).toBe(1);
    const album = await AlbumModel.findOne({ 'externalIds.audiusId': 'alb-2' });
    expect(album).not.toBeNull();
  });

  it('does not sync albums when no album fetcher is provided', async () => {
    const connector = makeConnector([makeTrack('t1', 'artist-1')]);
    const result = await runAudiusImport('album-sync-folk', { connector });

    expect(result.albumsSynced).toBe(0);
    expect(await AlbumModel.countDocuments()).toBe(0);
  });
});

// ── enqueueAudiusImport ───────────────────────────────────────────────────────

describe('enqueueAudiusImport', () => {
  it('returns void synchronously and does not throw', () => {
    const connector = makeConnector([makeTrack('t9')]);
    // Must not throw synchronously
    expect(() => enqueueAudiusImport('test', { connector })).not.toThrow();
  });

  it('blank query is a no-op (no connector call)', async () => {
    let called = false;
    const connector: MusicSourceConnector = {
      provider: 'audius' as const,
      search: async () => { called = true; return []; },
    };

    enqueueAudiusImport('   ', { connector });
    // Yield to allow microtasks/promises to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(called).toBe(false);
  });

  it('does not throw even when connector rejects', async () => {
    const failConnector: MusicSourceConnector = {
      provider: 'audius' as const,
      search: async () => { throw new Error('network error'); },
    };

    // Must not throw synchronously
    expect(() => enqueueAudiusImport('classical', { connector: failConnector })).not.toThrow();
    // Wait for the background promise to settle — no unhandled rejection
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });
});
