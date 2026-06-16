import { describe, it, expect } from 'bun:test';
import { buildMasterPlaylist, buildVariantPlaylist } from './manifestService';
import type { ITrack } from '../../models/Track';
import type { Document } from 'mongoose';

process.env.STREAM_TOKEN_SECRET = 'test-secret-manifest';

const TRACK_ID = 'aabbccddeeff001122334455';
const TOKEN = 'tok-manifest';
const BASE_URL = 'https://api.syra.oxy.so';

// ── Minimal ITrack-like fixture (no real Mongoose Document needed) ─────────────

function makeTrack(overrides: Record<string, unknown> = {}): ITrack {
  return {
    _id: { toString: () => TRACK_ID } as ITrack['_id'],
    title: 'Test',
    artistId: 'artist-id',
    artistName: 'Artist',
    duration: 180,
    source: 'upload',
    status: 'ready',
    isExplicit: false,
    isAvailable: true,
    hlsMasterKey: 'hls/artist/track/master.m3u8',
    hls: [
      { manifestKey: 'hls/artist/track/96/index.m3u8', bitrateKbps: 96, encrypted: true },
      { manifestKey: 'hls/artist/track/160/index.m3u8', bitrateKbps: 160, encrypted: true },
      { manifestKey: 'hls/artist/track/320/index.m3u8', bitrateKbps: 320, encrypted: true },
    ],
    ...overrides,
  } as unknown as ITrack;
}

// ── Synthetic playlist texts ──────────────────────────────────────────────────

const FAKE_MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=96000',
  '96/stream.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=160000',
  '160/stream.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=320000',
  '320/stream.m3u8',
].join('\n');

const FAKE_VARIANT_96 = [
  '#EXTM3U',
  '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0xdeadbeef',
  '#EXTINF:10.0,',
  'segment-0.ts',
  '#EXTINF:4.3,',
  'segment-1.ts',
  '#EXT-X-ENDLIST',
].join('\n');

// ── DI helpers ────────────────────────────────────────────────────────────────

function makeDeps(masterText: string, variantText: string) {
  return {
    fetchText: async (key: string): Promise<string> => {
      if (key.endsWith('master.m3u8')) return masterText;
      return variantText;
    },
    presign: async (key: string): Promise<string> =>
      `https://s3.example/${key.split('/').pop()}?sig=fake`,
  };
}

// ── buildMasterPlaylist ───────────────────────────────────────────────────────

describe('buildMasterPlaylist', () => {
  it('fetches the master key and rewrites variant lines', async () => {
    const track = makeTrack();
    const deps = makeDeps(FAKE_MASTER, FAKE_VARIANT_96);

    const result = await buildMasterPlaylist(track, TOKEN, BASE_URL, deps);

    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/96.m3u8?t=${TOKEN}`);
    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/160.m3u8?t=${TOKEN}`);
    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/320.m3u8?t=${TOKEN}`);
    expect(result).toContain('#EXTM3U');
    // Original paths must be replaced
    expect(result).not.toContain('96/stream.m3u8');
  });
});

// ── buildVariantPlaylist ──────────────────────────────────────────────────────

describe('buildVariantPlaylist', () => {
  it('fetches the correct rendition and rewrites segments + key URI', async () => {
    const track = makeTrack();
    const deps = makeDeps(FAKE_MASTER, FAKE_VARIANT_96);

    const result = await buildVariantPlaylist(track, 96, TOKEN, BASE_URL, deps);

    expect(result).toContain('https://s3.example/segment-0.ts?sig=fake');
    expect(result).toContain('https://s3.example/segment-1.ts?sig=fake');
    expect(result).toContain(`URI="${BASE_URL}/api/stream/${TRACK_ID}/key?t=${TOKEN}"`);
    expect(result).toContain('METHOD=AES-128');
    expect(result).toContain('IV=0xdeadbeef');
  });

  it('throws when the requested bitrateKbps is not in track.hls', async () => {
    const track = makeTrack();
    const deps = makeDeps(FAKE_MASTER, FAKE_VARIANT_96);

    await expect(
      buildVariantPlaylist(track, 999, TOKEN, BASE_URL, deps),
    ).rejects.toThrow();
  });
});
