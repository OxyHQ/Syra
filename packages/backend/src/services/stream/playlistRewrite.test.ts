import { describe, it, expect } from 'bun:test';
import { rewriteVariantPlaylist } from './playlistRewrite';

const TRACK_ID = 'aabbccddeeff001122334455';
const TOKEN = 'tok123';
const BASE_URL = 'https://api.syra.fm';

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
