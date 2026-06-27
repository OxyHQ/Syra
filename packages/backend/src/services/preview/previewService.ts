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
 * HLS rendition / key.
 *
 * Materializes the lowest-bitrate rendition locally (key file + variant playlist
 * with its `#EXT-X-KEY` URI rewritten to the local key + the referenced segments)
 * and lets ffmpeg perform the AES-128 decryption and clipping.
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

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-hls-'));
  try {
    // 1. Local AES-128 key file referenced by the rewritten playlist.
    fs.writeFileSync(path.join(workDir, 'key.bin'), Buffer.from(keyHex, 'hex'));

    // 2. Rewrite the playlist: point EXT-X-KEY at the local key; collect segments.
    const segmentNames: string[] = [];
    const rewritten = playlistText
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXT-X-KEY:')) {
          return line.replace(/URI="[^"]*"/, 'URI="key.bin"');
        }
        if (!trimmed || trimmed.startsWith('#')) {
          return line;
        }
        assertSafeSegmentName(trimmed);
        segmentNames.push(trimmed);
        return line;
      })
      .join('\n');

    if (segmentNames.length === 0) {
      return null;
    }

    fs.writeFileSync(path.join(workDir, 'index.m3u8'), rewritten);

    // 3. Download every referenced segment next to the playlist.
    await Promise.all(
      segmentNames.map(async (name) => {
        const buffer = await fetchSegment(`${manifestDir}/${name}`);
        fs.writeFileSync(path.join(workDir, name), buffer);
      }),
    );

    // 4. Decrypt + clip + upload.
    const outPath = path.join(workDir, `clip-${Math.max(0, Math.trunc(startSec))}.mp3`);
    await runClip({ playlistPath: path.join(workDir, 'index.m3u8'), startSec, outPath });

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
