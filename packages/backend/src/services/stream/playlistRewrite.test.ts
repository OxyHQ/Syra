import { describe, it, expect } from 'bun:test';
import { rewriteMasterPlaylist, rewriteVariantPlaylist } from './playlistRewrite';

const TRACK_ID = 'aabbccddeeff001122334455';
const TOKEN = 'tok123';
const BASE_URL = 'https://api.syra.oxy.so';

// ── Synthetic playlists ───────────────────────────────────────────────────────

const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=96000,CODECS="mp4a.40.2"',
  '96/stream.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2"',
  '160/stream.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=320000,CODECS="mp4a.40.2"',
  '320/stream.m3u8',
].join('\n');

const VARIANT_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0xdeadbeef00000000deadbeef00000000',
  '#EXTINF:10.0,',
  'segment-0.ts',
  '#EXTINF:10.0,',
  'segment-1.ts',
  '#EXTINF:4.3,',
  'segment-2.ts',
  '#EXT-X-ENDLIST',
].join('\n');

// ── rewriteMasterPlaylist ─────────────────────────────────────────────────────

describe('rewriteMasterPlaylist', () => {
  it('rewrites each variant path to a tokenized API URL', () => {
    const result = rewriteMasterPlaylist(MASTER_PLAYLIST, {
      trackId: TRACK_ID,
      token: TOKEN,
      baseUrl: BASE_URL,
    });
    const lines = result.split('\n');

    expect(lines).toContain(
      `${BASE_URL}/api/stream/${TRACK_ID}/v/96.m3u8?t=${TOKEN}`,
    );
    expect(lines).toContain(
      `${BASE_URL}/api/stream/${TRACK_ID}/v/160.m3u8?t=${TOKEN}`,
    );
    expect(lines).toContain(
      `${BASE_URL}/api/stream/${TRACK_ID}/v/320.m3u8?t=${TOKEN}`,
    );
  });

  it('leaves #EXTM3U, #EXT-X-STREAM-INF, and other tag lines untouched', () => {
    const result = rewriteMasterPlaylist(MASTER_PLAYLIST, {
      trackId: TRACK_ID,
      token: TOKEN,
      baseUrl: BASE_URL,
    });
    const lines = result.split('\n');

    expect(lines).toContain('#EXTM3U');
    expect(lines).toContain('#EXT-X-VERSION:3');
    expect(lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF'))).toHaveLength(3);
  });

  it('does not include the original variant paths', () => {
    const result = rewriteMasterPlaylist(MASTER_PLAYLIST, {
      trackId: TRACK_ID,
      token: TOKEN,
      baseUrl: BASE_URL,
    });

    expect(result).not.toContain('96/stream.m3u8');
    expect(result).not.toContain('160/stream.m3u8');
    expect(result).not.toContain('320/stream.m3u8');
  });
});

// ── rewriteVariantPlaylist ────────────────────────────────────────────────────

describe('rewriteVariantPlaylist', () => {
  async function fakePres(seg: string): Promise<string> {
    return `https://s3.example/${seg}?sig=fake`;
  }

  it('replaces segment lines with presigned URLs', async () => {
    const result = await rewriteVariantPlaylist(VARIANT_PLAYLIST, {
      trackId: TRACK_ID,
      token: TOKEN,
      baseUrl: BASE_URL,
      presign: fakePres,
    });
    const lines = result.split('\n');

    expect(lines).toContain('https://s3.example/segment-0.ts?sig=fake');
    expect(lines).toContain('https://s3.example/segment-1.ts?sig=fake');
    expect(lines).toContain('https://s3.example/segment-2.ts?sig=fake');
  });

  it('rewrites EXT-X-KEY URI to the tokenized key endpoint', async () => {
    const result = await rewriteVariantPlaylist(VARIANT_PLAYLIST, {
      trackId: TRACK_ID,
      token: TOKEN,
      baseUrl: BASE_URL,
      presign: fakePres,
    });

    expect(result).toContain(
      `URI="${BASE_URL}/api/stream/${TRACK_ID}/key?t=${TOKEN}"`,
    );
  });

  it('preserves METHOD=AES-128 and the IV= param in EXT-X-KEY', async () => {
    const result = await rewriteVariantPlaylist(VARIANT_PLAYLIST, {
      trackId: TRACK_ID,
      token: TOKEN,
      baseUrl: BASE_URL,
      presign: fakePres,
    });
    const keyLine = result.split('\n').find((l) => l.startsWith('#EXT-X-KEY'));

    expect(keyLine).toBeDefined();
    expect(keyLine).toContain('METHOD=AES-128');
    expect(keyLine).toContain('IV=0xdeadbeef00000000deadbeef00000000');
  });

  it('leaves #EXTINF and other tag lines untouched', async () => {
    const result = await rewriteVariantPlaylist(VARIANT_PLAYLIST, {
      trackId: TRACK_ID,
      token: TOKEN,
      baseUrl: BASE_URL,
      presign: fakePres,
    });
    const lines = result.split('\n');

    expect(lines).toContain('#EXTM3U');
    expect(lines).toContain('#EXT-X-TARGETDURATION:10');
    expect(lines.filter((l) => l.startsWith('#EXTINF'))).toHaveLength(3);
    expect(lines).toContain('#EXT-X-ENDLIST');
  });

  it('does not include the original segment filenames', async () => {
    const result = await rewriteVariantPlaylist(VARIANT_PLAYLIST, {
      trackId: TRACK_ID,
      token: TOKEN,
      baseUrl: BASE_URL,
      presign: fakePres,
    });

    // Original bare filenames must be gone
    expect(result).not.toContain('\nsegment-0.ts\n');
    expect(result).not.toContain('\nsegment-1.ts\n');
  });
});
