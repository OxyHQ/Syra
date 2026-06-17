import { describe, it, expect } from 'bun:test';
import { buildMasterPlaylist, buildVariantPlaylist } from './manifestService';
import type { ITrack } from '../../models/Track';

process.env.STREAM_TOKEN_SECRET = 'test-secret-manifest';

const TRACK_ID = 'aabbccddeeff001122334455';
const TOKEN = 'tok-manifest';
const BASE_URL = 'https://api.syra.fm';

// ── Minimal ITrack-like fixture ───────────────────────────────────────────────

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

// ── Synthetic variant text (master no longer fetched from S3) ─────────────────

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

function makeDeps(variantText: string) {
  return {
    // fetchText is only used for variant playlists now
    fetchText: async (_key: string): Promise<string> => variantText,
    presign: async (key: string): Promise<string> =>
      `https://s3.example/${key.split('/').pop()}?sig=fake`,
  };
}

// ── buildMasterPlaylist ───────────────────────────────────────────────────────

describe('buildMasterPlaylist', () => {
  it('cap=320: includes all three renditions', async () => {
    const track = makeTrack();
    const deps = makeDeps(FAKE_VARIANT_96);

    const result = await buildMasterPlaylist(track, TOKEN, BASE_URL, 320, deps);

    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/96.m3u8?t=${TOKEN}`);
    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/160.m3u8?t=${TOKEN}`);
    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/320.m3u8?t=${TOKEN}`);
    expect(result).toContain('#EXTM3U');
  });

  it('cap=160: excludes 320 rendition', async () => {
    const track = makeTrack();
    const deps = makeDeps(FAKE_VARIANT_96);

    const result = await buildMasterPlaylist(track, TOKEN, BASE_URL, 160, deps);

    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/96.m3u8?t=${TOKEN}`);
    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/160.m3u8?t=${TOKEN}`);
    expect(result).not.toContain(`/v/320.m3u8`);
  });

  it('cap=96: only includes 96 rendition', async () => {
    const track = makeTrack();
    const deps = makeDeps(FAKE_VARIANT_96);

    const result = await buildMasterPlaylist(track, TOKEN, BASE_URL, 96, deps);

    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/96.m3u8?t=${TOKEN}`);
    expect(result).not.toContain(`/v/160.m3u8`);
    expect(result).not.toContain(`/v/320.m3u8`);
  });

  it('emits correct #EXT-X-STREAM-INF BANDWIDTH for each included rendition', async () => {
    const track = makeTrack();
    const deps = makeDeps(FAKE_VARIANT_96);

    const result = await buildMasterPlaylist(track, TOKEN, BASE_URL, 160, deps);

    expect(result).toContain('BANDWIDTH=96000');
    expect(result).toContain('BANDWIDTH=160000');
    expect(result).not.toContain('BANDWIDTH=320000');
  });
});

// ── buildVariantPlaylist ──────────────────────────────────────────────────────

describe('buildVariantPlaylist', () => {
  it('fetches the correct rendition and rewrites segments + key URI', async () => {
    const track = makeTrack();
    const deps = makeDeps(FAKE_VARIANT_96);

    const result = await buildVariantPlaylist(track, 96, TOKEN, BASE_URL, deps);

    expect(result).toContain('https://s3.example/segment-0.ts?sig=fake');
    expect(result).toContain('https://s3.example/segment-1.ts?sig=fake');
    expect(result).toContain(`URI="${BASE_URL}/api/stream/${TRACK_ID}/key?t=${TOKEN}"`);
    expect(result).toContain('METHOD=AES-128');
    expect(result).toContain('IV=0xdeadbeef');
  });

  it('throws when the requested bitrateKbps is not in track.hls', async () => {
    const track = makeTrack();
    const deps = makeDeps(FAKE_VARIANT_96);

    await expect(
      buildVariantPlaylist(track, 999, TOKEN, BASE_URL, deps),
    ).rejects.toThrow();
  });
});
