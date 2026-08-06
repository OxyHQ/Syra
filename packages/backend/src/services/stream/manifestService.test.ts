import { describe, it, expect } from 'bun:test';
import type { HlsRendition } from '@syra/shared-types';
import { buildMasterPlaylistFor, buildVariantPlaylistFor } from './manifestService';

process.env.STREAM_TOKEN_SECRET = 'test-secret-manifest';

/**
 * A uuid v7, not a 24-char ObjectId hex. Ids are minted by `generatedId()` now,
 * and the track path is built by interpolating whatever id the caller passes —
 * so a fixture still shaped like an ObjectId would assert the URLs of an id
 * space nothing writes any more.
 */
const TRACK_ID = '019fd8e0-fdc5-7b54-a9ce-6155ad5b3c6f';
const TOKEN = 'tok-manifest';
const BASE_URL = 'https://api.syra.fm';
const BASE_PATH = `/api/stream/${TRACK_ID}`;

/**
 * The ladder as `track_hls_renditions` returns it — the caller's job since the
 * two `ITrack` adapters were deleted, because `track.hls` no longer exists as a
 * column and those adapters read exactly it.
 */
function makeRenditions(): HlsRendition[] {
  return [
    { manifestKey: 'hls/artist/track/96/index.m3u8', bitrateKbps: 96, encrypted: true },
    { manifestKey: 'hls/artist/track/160/index.m3u8', bitrateKbps: 160, encrypted: true },
    { manifestKey: 'hls/artist/track/320/index.m3u8', bitrateKbps: 320, encrypted: true },
  ];
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

// ── buildMasterPlaylistFor ────────────────────────────────────────────────────

describe('buildMasterPlaylistFor', () => {
  it('cap=320: includes all three renditions', async () => {
    const hls = makeRenditions();
    const deps = makeDeps(FAKE_VARIANT_96);

    const result = await buildMasterPlaylistFor(
      { id: TRACK_ID, hls },
      { token: TOKEN, baseUrl: BASE_URL, maxBitrateKbps: 320, basePath: BASE_PATH },
    );

    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/96.m3u8?t=${TOKEN}`);
    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/160.m3u8?t=${TOKEN}`);
    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/320.m3u8?t=${TOKEN}`);
    expect(result).toContain('#EXTM3U');
  });

  it('cap=160: excludes 320 rendition', async () => {
    const hls = makeRenditions();
    const deps = makeDeps(FAKE_VARIANT_96);

    const result = await buildMasterPlaylistFor(
      { id: TRACK_ID, hls },
      { token: TOKEN, baseUrl: BASE_URL, maxBitrateKbps: 160, basePath: BASE_PATH },
    );

    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/96.m3u8?t=${TOKEN}`);
    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/160.m3u8?t=${TOKEN}`);
    expect(result).not.toContain(`/v/320.m3u8`);
  });

  it('cap=96: only includes 96 rendition', async () => {
    const hls = makeRenditions();
    const deps = makeDeps(FAKE_VARIANT_96);

    const result = await buildMasterPlaylistFor(
      { id: TRACK_ID, hls },
      { token: TOKEN, baseUrl: BASE_URL, maxBitrateKbps: 96, basePath: BASE_PATH },
    );

    expect(result).toContain(`${BASE_URL}/api/stream/${TRACK_ID}/v/96.m3u8?t=${TOKEN}`);
    expect(result).not.toContain(`/v/160.m3u8`);
    expect(result).not.toContain(`/v/320.m3u8`);
  });

  it('emits correct #EXT-X-STREAM-INF BANDWIDTH for each included rendition', async () => {
    const hls = makeRenditions();
    const deps = makeDeps(FAKE_VARIANT_96);

    const result = await buildMasterPlaylistFor(
      { id: TRACK_ID, hls },
      { token: TOKEN, baseUrl: BASE_URL, maxBitrateKbps: 160, basePath: BASE_PATH },
    );

    expect(result).toContain('BANDWIDTH=96000');
    expect(result).toContain('BANDWIDTH=160000');
    expect(result).not.toContain('BANDWIDTH=320000');
  });
});

// ── buildVariantPlaylistFor ───────────────────────────────────────────────────

describe('buildVariantPlaylistFor', () => {
  it('fetches the correct rendition and rewrites segments + key URI', async () => {
    const hls = makeRenditions();
    const deps = makeDeps(FAKE_VARIANT_96);

    const result = await buildVariantPlaylistFor(
      { id: TRACK_ID, hls },
      { bitrateKbps: 96, token: TOKEN, baseUrl: BASE_URL, basePath: BASE_PATH, deps },
    );

    expect(result).toContain('https://s3.example/segment-0.ts?sig=fake');
    expect(result).toContain('https://s3.example/segment-1.ts?sig=fake');
    expect(result).toContain(`URI="${BASE_URL}/api/stream/${TRACK_ID}/key?t=${TOKEN}"`);
    expect(result).toContain('METHOD=AES-128');
    expect(result).toContain('IV=0xdeadbeef');
  });

  it('throws when the requested bitrateKbps is not in the ladder', async () => {
    const hls = makeRenditions();
    const deps = makeDeps(FAKE_VARIANT_96);

    await expect(
      buildVariantPlaylistFor(
        { id: TRACK_ID, hls },
        { bitrateKbps: 999, token: TOKEN, baseUrl: BASE_URL, basePath: BASE_PATH, deps },
      ),
    ).rejects.toThrow();
  });
});
