import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFile as execFileCb, execFileSync } from 'child_process';
import crypto from 'crypto';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { HlsRendition } from '@syra/shared-types';
import {
  storePreviewFromHls,
  buildWindowedHlsPlaylist,
  type HlsPreviewDeps,
} from './previewService';
import { getS3PreviewKey } from '../../config/s3.config';
import { PREVIEW_CONTENT_TYPE, generatePreviewClipFromHls } from '../ingest/previewClip';
import type { GeneratePreviewClipFromHlsOptions } from '../ingest/previewClip';

const execFile = promisify(execFileCb);
function hasBinary(name: string): boolean {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
const HLS_TOOLS_AVAILABLE = ['ffmpeg', 'ffprobe', 'mp42hls', 'mp4fragment'].every(hasBinary);

const TRACK_ID = 'track-1';
const KEY_HEX = 'deadbeefdeadbeefdeadbeefdeadbeef'; // 16 bytes

const HLS: HlsRendition[] = [
  { manifestKey: 'hls/artist-1/track-1/320/stream.m3u8', bitrateKbps: 320, encrypted: true },
  { manifestKey: 'hls/artist-1/track-1/96/stream.m3u8', bitrateKbps: 96, encrypted: true },
];

/** Build a synthetic VOD variant playlist with `count` segments of `dur` seconds. */
function makePlaylist(count: number, dur = 6): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-KEY:METHOD=AES-128,URI="/api/stream/track-1/key"',
  ];
  for (let i = 0; i < count; i++) {
    lines.push(`#EXTINF:${dur},`, `segment-${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

// ── Pure windowing ──────────────────────────────────────────────────────────────

describe('buildWindowedHlsPlaylist', () => {
  it('start=0 keeps only segments covering [0,30] with seek 0 and unchanged media sequence', () => {
    const w = buildWindowedHlsPlaylist(makePlaylist(12), { startSec: 0, clipSec: 30 });
    // 6s segments: seg0..seg4 start at 0,6,12,18,24 (<30); seg5 starts at 30 → excluded.
    expect(w.segmentNames).toEqual(['segment-0.ts', 'segment-1.ts', 'segment-2.ts', 'segment-3.ts', 'segment-4.ts']);
    expect(w.seekSec).toBe(0);
    expect(w.playlist).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(w.playlist).toContain('URI="key.bin"');
    expect(w.playlist).not.toContain('/api/stream/track-1/key');
    expect(w.playlist).toContain('#EXT-X-ENDLIST');
    expect(w.playlist).not.toContain('segment-5.ts');
  });

  it('mid start windows the segments, includes one lookback, rebases media sequence, and seeks', () => {
    const w = buildWindowedHlsPlaylist(makePlaylist(12), { startSec: 30, clipSec: 30 });
    // start=30 is in seg5; lookback → startIdx=4; windowEnd=60 → seg4..seg9 (segStart 24..54 <60).
    expect(w.segmentNames).toEqual([
      'segment-4.ts', 'segment-5.ts', 'segment-6.ts', 'segment-7.ts', 'segment-8.ts', 'segment-9.ts',
    ]);
    // seek = start - segStart[4] = 30 - 24 = 6 (the lookback segment is discarded by the seek).
    expect(w.seekSec).toBe(6);
    // media sequence rebased to the first kept segment so AES-CBC IVs stay correct.
    expect(w.playlist).toContain('#EXT-X-MEDIA-SEQUENCE:4');
    expect(w.playlist).not.toContain('segment-3.ts');
    expect(w.playlist).not.toContain('segment-10.ts');
  });

  it('returns empty when there are no segments', () => {
    const w = buildWindowedHlsPlaylist('#EXTM3U\n#EXT-X-ENDLIST\n', { startSec: 0, clipSec: 30 });
    expect(w.segmentNames).toEqual([]);
  });

  it('rejects an unsafe segment name (path traversal)', () => {
    const evil = '#EXTM3U\n#EXTINF:6.0,\n../../etc/passwd\n#EXT-X-ENDLIST\n';
    expect(() => buildWindowedHlsPlaylist(evil, { startSec: 0, clipSec: 30 })).toThrow(/Unsafe HLS segment name/);
  });
});

// ── Hermetic storePreviewFromHls (injected I/O) ─────────────────────────────────

describe('storePreviewFromHls (hermetic, injected I/O)', () => {
  it('picks the lowest rendition, materializes the window, clips, and uploads', async () => {
    const fetchTextKeys: string[] = [];
    const fetchSegmentKeys: string[] = [];
    const uploads: { key: string; contentType: string; size: number }[] = [];
    let clipCalls = 0;
    let capturedPlaylist = '';
    let capturedSeek = -1;
    let keyBytesLen = -1;

    const deps: HlsPreviewDeps = {
      getKeyHex: async () => KEY_HEX,
      fetchText: async (key) => { fetchTextKeys.push(key); return makePlaylist(2); },
      fetchSegment: async (key) => { fetchSegmentKeys.push(key); return Buffer.from(`ts:${key}`); },
      runClip: async (opts: GeneratePreviewClipFromHlsOptions) => {
        clipCalls += 1;
        const dir = path.dirname(opts.playlistPath);
        capturedPlaylist = fs.readFileSync(opts.playlistPath, 'utf8');
        capturedSeek = opts.startSec;
        keyBytesLen = fs.readFileSync(path.join(dir, 'key.bin')).length;
        fs.writeFileSync(opts.outPath, Buffer.from('fake-mp3-bytes'));
        return opts.outPath;
      },
      upload: async (key, body, opts) => {
        uploads.push({ key, contentType: opts.contentType, size: body.length });
      },
    };

    const result = await storePreviewFromHls({ trackId: TRACK_ID, hls: HLS, startSec: 0 }, deps);

    expect(result).toBe(getS3PreviewKey(TRACK_ID, 0));
    expect(fetchTextKeys).toEqual(['hls/artist-1/track-1/96/stream.m3u8']); // lowest rendition
    // 2 segments × 6s = 12s, both within [0,30] → both fetched by full S3 key.
    expect(fetchSegmentKeys.sort()).toEqual([
      'hls/artist-1/track-1/96/segment-0.ts',
      'hls/artist-1/track-1/96/segment-1.ts',
    ]);
    expect(capturedPlaylist).toContain('URI="key.bin"');
    expect(capturedPlaylist).not.toContain('/api/stream/track-1/key');
    expect(capturedSeek).toBe(0);
    expect(keyBytesLen).toBe(16);
    expect(clipCalls).toBe(1);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].key).toBe(getS3PreviewKey(TRACK_ID, 0));
    expect(uploads[0].contentType).toBe(PREVIEW_CONTENT_TYPE);
  });

  it('downloads ONLY the windowed segments for a mid-track start', async () => {
    const fetchSegmentKeys: string[] = [];
    let capturedSeek = -1;

    await storePreviewFromHls(
      { trackId: TRACK_ID, hls: HLS, startSec: 30 },
      {
        getKeyHex: async () => KEY_HEX,
        fetchText: async () => makePlaylist(12),
        fetchSegment: async (key) => { fetchSegmentKeys.push(key); return Buffer.from('ts'); },
        runClip: async (opts) => { capturedSeek = opts.startSec; fs.writeFileSync(opts.outPath, Buffer.from('x')); return opts.outPath; },
        upload: async () => {},
      },
    );

    // start=30 → seg4..seg9 only (6 of 12), NOT the whole track.
    expect(fetchSegmentKeys.map((k) => k.split('/').pop()).sort()).toEqual([
      'segment-4.ts', 'segment-5.ts', 'segment-6.ts', 'segment-7.ts', 'segment-8.ts', 'segment-9.ts',
    ]);
    expect(capturedSeek).toBe(6);
  });

  it('returns null when no AES key is stored for the track', async () => {
    let clipCalls = 0;
    const result = await storePreviewFromHls(
      { trackId: TRACK_ID, hls: HLS, startSec: 0 },
      {
        getKeyHex: async () => null,
        fetchText: async () => makePlaylist(2),
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
});

// ── Real end-to-end: encrypted HLS → windowed materialization → decrypt ─────────

describe.skipIf(!HLS_TOOLS_AVAILABLE)('storePreviewFromHls real decrypt (requires ffmpeg + Bento4)', () => {
  let renditionDir: string;
  let keyHex: string;

  beforeAll(async () => {
    if (!HLS_TOOLS_AVAILABLE) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-hls-e2e-'));
    renditionDir = path.join(root, '96');
    fs.mkdirSync(renditionDir, { recursive: true });
    const srcMp4 = path.join(root, 'src.mp4');
    const fragMp4 = path.join(root, 'frag.mp4');

    await execFile('ffmpeg', [
      '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', srcMp4, '-y',
    ], { maxBuffer: 8 * 1024 * 1024 });
    await execFile('mp4fragment', [srcMp4, fragMp4]);
    keyHex = crypto.randomBytes(16).toString('hex');
    await execFile('mp42hls', [
      '--encryption-mode', 'AES-128', '--encryption-key', keyHex, '--encryption-key-uri', 'key', fragMp4,
    ], { cwd: renditionDir });
  }, 120_000);

  afterAll(() => {
    if (!HLS_TOOLS_AVAILABLE) return;
    fs.rmSync(path.dirname(renditionDir), { recursive: true, force: true });
  });

  it('produces a valid ~25s MP3 from start=15 using only the windowed segments', async () => {
    const fetchedSegments: string[] = [];
    let uploadedBody: Buffer | undefined;

    const result = await storePreviewFromHls(
      { trackId: 'e2e', hls: [{ manifestKey: 'hls/a/t/96/stream.m3u8', bitrateKbps: 96, encrypted: true }], startSec: 15 },
      {
        getKeyHex: async () => keyHex,
        fetchText: async () => fs.readFileSync(path.join(renditionDir, 'stream.m3u8'), 'utf8'),
        fetchSegment: async (key) => {
          const name = key.split('/').pop() ?? '';
          fetchedSegments.push(name);
          return fs.readFileSync(path.join(renditionDir, name));
        },
        runClip: generatePreviewClipFromHls, // real ffmpeg decrypt
        upload: async (_key, body) => { uploadedBody = Buffer.from(body); },
      },
    );

    expect(result).toBe(getS3PreviewKey('e2e', 15));
    // Windowed: a strict subset of the 7 segments (not the whole track).
    expect(fetchedSegments.length).toBeLessThan(7);
    expect(uploadedBody).toBeDefined();

    // Probe the decrypted clip: valid mp3, ~25s (40s source seeked to 15s).
    const probe = path.join(os.tmpdir(), `e2e-clip-${Date.now()}.mp3`);
    fs.writeFileSync(probe, uploadedBody ?? Buffer.alloc(0));
    try {
      const codec = (await execFile('ffprobe', [
        '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', probe,
      ])).stdout.trim();
      const duration = Number((await execFile('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', probe,
      ])).stdout.trim());
      expect(codec).toBe('mp3');
      expect(duration).toBeGreaterThan(23);
      expect(duration).toBeLessThan(27);
    } finally {
      fs.rmSync(probe, { force: true });
    }
  }, 60_000);
});
