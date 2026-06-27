import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import type { HlsRendition } from '@syra/shared-types';
import { storePreviewFromHls, type HlsPreviewDeps } from './previewService';
import { getS3PreviewKey } from '../../config/s3.config';
import { PREVIEW_CONTENT_TYPE } from '../ingest/previewClip';
import type { GeneratePreviewClipFromHlsOptions } from '../ingest/previewClip';

const TRACK_ID = 'track-1';
const KEY_HEX = 'deadbeefdeadbeefdeadbeefdeadbeef'; // 16 bytes

const HLS: HlsRendition[] = [
  { manifestKey: 'hls/artist-1/track-1/320/stream.m3u8', bitrateKbps: 320, encrypted: true },
  { manifestKey: 'hls/artist-1/track-1/96/stream.m3u8', bitrateKbps: 96, encrypted: true },
];

const FAKE_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-KEY:METHOD=AES-128,URI="/api/stream/track-1/key"',
  '#EXTINF:6.0,',
  'segment-0.ts',
  '#EXTINF:6.0,',
  'segment-1.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

describe('storePreviewFromHls (hermetic, injected I/O)', () => {
  it('picks the lowest rendition, rewrites the key URI to a local file, fetches segments, clips, and uploads', async () => {
    const fetchTextKeys: string[] = [];
    const fetchSegmentKeys: string[] = [];
    const uploads: { key: string; contentType: string; size: number }[] = [];
    let clipCalls = 0;
    let capturedPlaylist = '';
    let keyBytesLen = -1;
    let segmentsOnDisk: string[] = [];

    const deps: HlsPreviewDeps = {
      getKeyHex: async () => KEY_HEX,
      fetchText: async (key) => {
        fetchTextKeys.push(key);
        return FAKE_PLAYLIST;
      },
      fetchSegment: async (key) => {
        fetchSegmentKeys.push(key);
        return Buffer.from(`ts:${key}`);
      },
      runClip: async (opts: GeneratePreviewClipFromHlsOptions) => {
        clipCalls += 1;
        const dir = path.dirname(opts.playlistPath);
        capturedPlaylist = fs.readFileSync(opts.playlistPath, 'utf8');
        keyBytesLen = fs.readFileSync(path.join(dir, 'key.bin')).length;
        segmentsOnDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
        fs.writeFileSync(opts.outPath, Buffer.from('fake-mp3-bytes'));
        return opts.outPath;
      },
      upload: async (key, body, opts) => {
        uploads.push({ key, contentType: opts.contentType, size: body.length });
      },
    };

    const result = await storePreviewFromHls({ trackId: TRACK_ID, hls: HLS, startSec: 0 }, deps);

    expect(result).toBe(getS3PreviewKey(TRACK_ID, 0));

    // Lowest rendition (96) playlist was fetched.
    expect(fetchTextKeys).toEqual(['hls/artist-1/track-1/96/stream.m3u8']);

    // Segments fetched by full S3 key under the rendition dir.
    expect(fetchSegmentKeys.sort()).toEqual([
      'hls/artist-1/track-1/96/segment-0.ts',
      'hls/artist-1/track-1/96/segment-1.ts',
    ]);

    // Playlist rewritten: key URI points at the local file, original is gone.
    expect(capturedPlaylist).toContain('URI="key.bin"');
    expect(capturedPlaylist).not.toContain('/api/stream/track-1/key');
    // Segment lines are preserved (relative names resolve to local files).
    expect(capturedPlaylist).toContain('segment-0.ts');

    // Key + segments materialized on disk next to the playlist.
    expect(keyBytesLen).toBe(16);
    expect(segmentsOnDisk).toEqual(['segment-0.ts', 'segment-1.ts']);

    // Clip ran once; the decrypted clip was uploaded to the public preview key.
    expect(clipCalls).toBe(1);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].key).toBe(getS3PreviewKey(TRACK_ID, 0));
    expect(uploads[0].contentType).toBe(PREVIEW_CONTENT_TYPE);
    expect(uploads[0].size).toBeGreaterThan(0);
  });

  it('returns null when no AES key is stored for the track', async () => {
    let clipCalls = 0;
    const result = await storePreviewFromHls(
      { trackId: TRACK_ID, hls: HLS, startSec: 0 },
      {
        getKeyHex: async () => null,
        fetchText: async () => FAKE_PLAYLIST,
        fetchSegment: async () => Buffer.alloc(0),
        runClip: async (opts) => { clipCalls += 1; return opts.outPath; },
        upload: async () => {},
      },
    );

    expect(result).toBeNull();
    expect(clipCalls).toBe(0);
  });

  it('returns null when there are no HLS renditions', async () => {
    const result = await storePreviewFromHls(
      { trackId: TRACK_ID, hls: [], startSec: 0 },
      { getKeyHex: async () => KEY_HEX },
    );
    expect(result).toBeNull();
  });

  it('rejects a playlist with an unsafe segment name (path traversal guard)', async () => {
    const evilPlaylist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key"',
      '#EXTINF:6.0,',
      '../../etc/passwd',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');

    await expect(
      storePreviewFromHls(
        { trackId: TRACK_ID, hls: HLS, startSec: 0 },
        {
          getKeyHex: async () => KEY_HEX,
          fetchText: async () => evilPlaylist,
          fetchSegment: async () => Buffer.alloc(0),
          runClip: async (opts) => opts.outPath,
          upload: async () => {},
        },
      ),
    ).rejects.toThrow(/Unsafe HLS segment name/);
  });
});
