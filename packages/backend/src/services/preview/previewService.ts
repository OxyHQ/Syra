/**
 * Preview service.
 *
 * Owns the lifecycle of the public 30s preview clips:
 *  - `storePreviewFromSourceFile` — generate a clip from an already-local source
 *    file and upload it to the public preview key. Used at ingest time, where
 *    the retained source is already on disk.
 *  - `storePreviewFromHls` — generate a clip from the track's own ENCRYPTED Syra
 *    HLS (Audius rehosted to Syra HLS, or any HLS-only track): the server holds
 *    the AES-128 key + segments, so it materializes them locally and lets ffmpeg
 *    decrypt + clip.
 *  - `ensurePreviewClip` — lazy path used by the public endpoint: if the clip is
 *    not already in S3, regenerate it from a Syra-native source (retained
 *    `audioSource` first, else ready HLS) and upload it; subsequent requests hit
 *    the cached object.
 *
 * A track is preview-eligible only when a clip is regenerable from a Syra-native
 * source. It NEVER depends on a direct-Audius provider stream. Tracks with no
 * regenerable source resolve to `null`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import type { AudioSource, HlsRendition } from '@syra/shared-types';
import { getS3PreviewKey } from '../../config/s3.config';
import { uploadToS3, streamFromS3, objectExists } from '../s3Service';
import { getTrackS3Key, type TrackAudioRef } from '../audioStorageService';
import { TrackKeyModel } from '../../models/TrackKey';
import {
  generatePreviewClip,
  generatePreviewClipFromHls,
  PREVIEW_CONTENT_TYPE,
  PREVIEW_DURATION_SEC,
} from '../ingest/previewClip';
import type { GeneratePreviewClipFromHlsOptions } from '../ingest/previewClip';

/** The fields of a track needed to resolve and regenerate a preview source. */
export interface PreviewSourceRef {
  id: string;
  artistId: string;
  albumId?: string;
  title: string;
  audioSource?: AudioSource;
  hls?: HlsRendition[];
}

export interface StorePreviewFromSourceParams {
  trackId: string;
  /** Local path to the retained source audio. */
  inputPath: string;
  /** Clamped, integer start offset in seconds. */
  startSec: number;
}

/**
 * Generate a preview clip from a local source file and upload it to the public
 * preview key. Returns the resulting S3 key.
 */
export async function storePreviewFromSourceFile(
  params: StorePreviewFromSourceParams,
): Promise<string> {
  const { trackId, inputPath, startSec } = params;
  const previewKey = getS3PreviewKey(trackId, startSec);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-out-'));
  const outPath = path.join(tmpDir, `${Math.max(0, Math.trunc(startSec))}.mp3`);

  try {
    await generatePreviewClip({ inputPath, startSec, outPath });
    const body = fs.readFileSync(outPath);
    await uploadToS3(previewKey, body, { contentType: PREVIEW_CONTENT_TYPE });
    return previewKey;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── HLS-source preview ─────────────────────────────────────────────────────────

export interface StorePreviewFromHlsParams {
  trackId: string;
  hls: HlsRendition[];
  startSec: number;
}

/** Injectable I/O so the HLS clip pipeline is unit-testable without S3/ffmpeg. */
export interface HlsPreviewDeps {
  /** Resolve the track's AES-128 key (hex) — `null` if no key is stored. */
  getKeyHex?: (trackId: string) => Promise<string | null>;
  /** Read an S3 object as UTF-8 text (the variant playlist). */
  fetchText?: (s3Key: string) => Promise<string>;
  /** Read an S3 object as a Buffer (a `.ts` segment). */
  fetchSegment?: (s3Key: string) => Promise<Buffer>;
  /** Run ffmpeg over the materialized playlist to produce the MP3 clip. */
  runClip?: (opts: GeneratePreviewClipFromHlsOptions) => Promise<string>;
  /** Upload the finished clip to the public preview key. */
  upload?: (key: string, body: Buffer, opts: { contentType: string }) => Promise<void>;
}

/** mp42hls emits flat `segment-N.ts` names; reject anything that could escape the dir. */
function assertSafeSegmentName(name: string): void {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Unsafe HLS segment name in playlist: ${name}`);
  }
}

const LOCAL_KEY_FILE = 'key.bin';

export interface WindowedHlsPlaylist {
  /** Rewritten variant playlist text (local key URI, rebased media sequence). */
  playlist: string;
  /** Ordered bare segment filenames to download for the window. */
  segmentNames: string[];
  /** `-ss` offset (seconds) to apply within the windowed playlist. */
  seekSec: number;
}

/**
 * Build a windowed variant playlist covering `[startSec, startSec + clipSec]` so
 * only the needed segments are downloaded (not the whole track).
 *
 * Correctness (verified): mp42hls encrypts each segment with no explicit IV, so
 * the AES-128-CBC IV is the segment's media-sequence number. Truncating the
 * playlist therefore REQUIRES rebasing `#EXT-X-MEDIA-SEQUENCE` to the first kept
 * segment's index, which keeps ffmpeg's per-segment IVs correct. One leading
 * segment of lookback is included (when `startSec` is not in the first segment)
 * so AAC decoder priming at the window's edge never bleeds into the clip — the
 * returned `seekSec` then discards that warmup.
 *
 * The `#EXT-X-KEY` URI is rewritten to the local key file. Returns empty
 * `segmentNames` when the playlist has no segments.
 */
export function buildWindowedHlsPlaylist(
  playlistText: string,
  opts: { startSec: number; clipSec: number; keyFileName?: string },
): WindowedHlsPlaylist {
  const keyFileName = opts.keyFileName ?? LOCAL_KEY_FILE;

  const headerLines: string[] = [];
  const segments: { duration: number; name: string }[] = [];
  let pendingDuration = 0;
  let seenSegment = false;

  for (const rawLine of playlistText.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#EXTINF:')) {
      seenSegment = true;
      const value = Number.parseFloat(line.slice('#EXTINF:'.length));
      pendingDuration = Number.isFinite(value) ? value : 0;
      continue;
    }
    if (!line || line.startsWith('#')) {
      // Header tags appear before the first segment; the trailing ENDLIST and
      // blank lines are dropped (ENDLIST is re-appended after the window).
      if (!seenSegment && line) headerLines.push(line);
      continue;
    }
    assertSafeSegmentName(line);
    segments.push({ duration: pendingDuration, name: line });
    pendingDuration = 0;
  }

  if (segments.length === 0) {
    return { playlist: '', segmentNames: [], seekSec: 0 };
  }

  const segStart: number[] = [];
  let acc = 0;
  for (const segment of segments) {
    segStart.push(acc);
    acc += segment.duration;
  }
  const total = acc;

  const start = Math.min(Math.max(0, opts.startSec), Math.max(0, total));

  // First segment that contains `start`.
  let targetIdx = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    if (start < segStart[i] + segments[i].duration) {
      targetIdx = i;
      break;
    }
  }
  // One segment of lookback (except when start is already in the first segment).
  const startIdx = Math.max(0, targetIdx - 1);

  const windowEnd = start + opts.clipSec;
  let endIdx = startIdx;
  for (let i = startIdx; i < segments.length; i++) {
    if (segStart[i] < windowEnd) endIdx = i;
    else break;
  }

  const origMediaSeq = (() => {
    const tag = headerLines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE'));
    const value = tag ? Number.parseInt(tag.split(':')[1] ?? '', 10) : 0;
    return Number.isFinite(value) ? value : 0;
  })();
  const newMediaSeq = origMediaSeq + startIdx;

  let mediaSeqWritten = false;
  const rewrittenHeader = headerLines.map((line) => {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      mediaSeqWritten = true;
      return `#EXT-X-MEDIA-SEQUENCE:${newMediaSeq}`;
    }
    if (line.startsWith('#EXT-X-KEY')) {
      return line.replace(/URI="[^"]*"/, `URI="${keyFileName}"`);
    }
    return line;
  });
  if (!mediaSeqWritten) {
    const afterExtm3u = rewrittenHeader.findIndex((l) => l.startsWith('#EXTM3U'));
    rewrittenHeader.splice(afterExtm3u + 1, 0, `#EXT-X-MEDIA-SEQUENCE:${newMediaSeq}`);
  }

  const kept = segments.slice(startIdx, endIdx + 1);
  const out = [...rewrittenHeader];
  for (const segment of kept) {
    out.push(`#EXTINF:${segment.duration},`);
    out.push(segment.name);
  }
  out.push('#EXT-X-ENDLIST');

  return {
    playlist: `${out.join('\n')}\n`,
    segmentNames: kept.map((s) => s.name),
    seekSec: start - segStart[startIdx],
  };
}

async function defaultGetKeyHex(trackId: string): Promise<string | null> {
  const trackKey = await TrackKeyModel.findOne({ trackId }).select('keyHex').lean<{ keyHex: string }>();
  return trackKey?.keyHex ?? null;
}

async function readS3Text(s3Key: string): Promise<string> {
  const { stream } = await streamFromS3(s3Key);
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

async function readS3Buffer(s3Key: string): Promise<Buffer> {
  const { stream } = await streamFromS3(s3Key);
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Lowest-bitrate rendition = smallest segments = cheapest preview source. */
function lowestRendition(hls: HlsRendition[]): HlsRendition | undefined {
  return [...hls].sort((a, b) => a.bitrateKbps - b.bitrateKbps)[0];
}

/**
 * Generate a preview clip from the track's encrypted Syra HLS and upload it to
 * the public preview key. Returns the S3 key, or `null` when there is no usable
 * HLS rendition / key / segment.
 *
 * Uses the lowest-bitrate rendition and a WINDOWED playlist (only the segments
 * covering `[startSec, startSec + 30]`, not the whole track). Materializes the
 * window locally — the AES key file, the rewritten variant playlist, and the
 * referenced segments — and lets ffmpeg perform the AES-128 decryption + clip.
 */
export async function storePreviewFromHls(
  params: StorePreviewFromHlsParams,
  deps: HlsPreviewDeps = {},
): Promise<string | null> {
  const { trackId, hls, startSec } = params;

  const rendition = lowestRendition(hls);
  if (!rendition) {
    return null;
  }

  const getKeyHex = deps.getKeyHex ?? defaultGetKeyHex;
  const fetchText = deps.fetchText ?? readS3Text;
  const fetchSegment = deps.fetchSegment ?? readS3Buffer;
  const runClip = deps.runClip ?? generatePreviewClipFromHls;
  const upload = deps.upload ?? uploadToS3;

  const keyHex = await getKeyHex(trackId);
  if (!keyHex) {
    return null;
  }

  const manifestKey = rendition.manifestKey;
  // S3 dir of the rendition: "hls/<artist>/<track>/96/stream.m3u8" → "hls/.../96"
  const manifestDir = manifestKey.replace(/\/[^/]+$/, '');
  const playlistText = await fetchText(manifestKey);

  const windowed = buildWindowedHlsPlaylist(playlistText, {
    startSec,
    clipSec: PREVIEW_DURATION_SEC,
  });
  if (windowed.segmentNames.length === 0) {
    return null;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-hls-'));
  try {
    // 1. Local AES-128 key file referenced by the rewritten playlist.
    fs.writeFileSync(path.join(workDir, LOCAL_KEY_FILE), Buffer.from(keyHex, 'hex'));

    // 2. Windowed playlist (key URI → local file, media sequence rebased).
    fs.writeFileSync(path.join(workDir, 'index.m3u8'), windowed.playlist);

    // 3. Download only the windowed segments next to the playlist.
    await Promise.all(
      windowed.segmentNames.map(async (name) => {
        const buffer = await fetchSegment(`${manifestDir}/${name}`);
        fs.writeFileSync(path.join(workDir, name), buffer);
      }),
    );

    // 4. Decrypt + clip (seek discards the lookback warmup) + upload.
    const outPath = path.join(workDir, `clip-${Math.max(0, Math.trunc(startSec))}.mp3`);
    await runClip({
      playlistPath: path.join(workDir, 'index.m3u8'),
      startSec: windowed.seekSec,
      outPath,
    });

    const body = fs.readFileSync(outPath);
    const previewKey = getS3PreviewKey(trackId, startSec);
    await upload(previewKey, body, { contentType: PREVIEW_CONTENT_TYPE });
    return previewKey;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ── Lazy resolver used by the public endpoint ───────────────────────────────────

/**
 * Ensure a preview clip exists for `(trackId, startSec)` and return its S3 key.
 *
 * Regenerates from a Syra-native source on a cache miss: a retained `audioSource`
 * first, else the track's own ready HLS. Returns `null` when neither source is
 * resolvable (the endpoint then 404s).
 */
export async function ensurePreviewClip(
  track: PreviewSourceRef,
  startSec: number,
): Promise<string | null> {
  const previewKey = getS3PreviewKey(track.id, startSec);
  if (await objectExists(previewKey)) {
    return previewKey;
  }

  // Path 1: retained source audio (uploads / CC).
  if (track.audioSource) {
    const sourceRef: TrackAudioRef = {
      id: track.id,
      artistId: track.artistId,
      albumId: track.albumId,
      title: track.title,
      audioSource: track.audioSource,
    };
    const sourceKey = getTrackS3Key(sourceRef);
    if (await objectExists(sourceKey)) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-src-'));
      const sourcePath = path.join(tmpDir, `source.${track.audioSource.format}`);
      try {
        const { stream } = await streamFromS3(sourceKey);
        await pipeToFile(stream, sourcePath);
        return await storePreviewFromSourceFile({
          trackId: track.id,
          inputPath: sourcePath,
          startSec,
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  }

  // Path 2: the track's own encrypted Syra HLS (Audius rehosted to Syra, etc.).
  if (track.hls && track.hls.length > 0) {
    return storePreviewFromHls({ trackId: track.id, hls: track.hls, startSec });
  }

  return null;
}

function pipeToFile(stream: Readable, destPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const dest = fs.createWriteStream(destPath);
    stream.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
    stream.on('error', reject);
  });
}
