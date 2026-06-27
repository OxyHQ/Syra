/**
 * Public preview-clip generator.
 *
 * Produces a short, UNENCRYPTED MP3 excerpt of a source audio file for the
 * public 30s preview surface. Unlike the HLS pipeline this is intentionally
 * plain (no AES-128, no loudnorm, no fragmentation) — the clip is served from a
 * public key and cached at the edge, so it must be directly playable by any
 * <audio> element / native player without a key request.
 *
 * ffmpeg is invoked the same way as `hlsPackager.ts` (execFile, no shell).
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

const EXEC_OPTS = { maxBuffer: 32 * 1024 * 1024 } as const;

/** Clip length in seconds. */
export const PREVIEW_DURATION_SEC = 30;
/** Constant MP3 bitrate for preview clips. */
export const PREVIEW_BITRATE_KBPS = 128;
/** Content type of a generated preview clip. */
export const PREVIEW_CONTENT_TYPE = 'audio/mpeg';

export interface GeneratePreviewClipOptions {
  /** Local path to the source audio (any ffmpeg-decodable format). */
  inputPath: string;
  /** Seek offset, in seconds, where the clip starts. */
  startSec: number;
  /** Local path the generated MP3 clip is written to. */
  outPath: string;
}

/**
 * Transcode a {@link PREVIEW_DURATION_SEC}-second MP3 excerpt starting at
 * `startSec`. `-ss` is placed before `-i` for fast (keyframe) seeking. Returns
 * the output path on success; throws with the ffmpeg stderr on failure.
 */
export async function generatePreviewClip(opts: GeneratePreviewClipOptions): Promise<string> {
  const { inputPath, startSec, outPath } = opts;

  await execFile(
    'ffmpeg',
    [
      '-nostdin',
      '-ss', String(startSec),
      '-t', String(PREVIEW_DURATION_SEC),
      '-i', inputPath,
      '-c:a', 'libmp3lame',
      '-b:a', `${PREVIEW_BITRATE_KBPS}k`,
      '-movflags', '+faststart',
      '-y',
      outPath,
    ],
    EXEC_OPTS,
  ).catch((err: { stderr?: string }) => {
    throw new Error(`ffmpeg preview clip failed: ${err.stderr ?? String(err)}`);
  });

  return outPath;
}

export interface GeneratePreviewClipFromHlsOptions {
  /**
   * Local path to a materialized variant playlist whose `#EXT-X-KEY` URI and
   * segment filenames resolve to local files (the AES-128 key written to disk +
   * the downloaded `.ts` segments).
   */
  playlistPath: string;
  /** Seek offset, in seconds, where the clip starts. */
  startSec: number;
  /** Local path the generated MP3 clip is written to. */
  outPath: string;
}

/**
 * Transcode a {@link PREVIEW_DURATION_SEC}-second MP3 excerpt from an encrypted
 * Syra HLS rendition that has been materialized to local files. ffmpeg performs
 * the AES-128 decryption itself via the playlist's `#EXT-X-KEY` (resolved to the
 * local key file). `-allowed_extensions ALL` permits the `.ts` segment names and
 * `-protocol_whitelist file,crypto,data` enables local decryption.
 */
export async function generatePreviewClipFromHls(
  opts: GeneratePreviewClipFromHlsOptions,
): Promise<string> {
  const { playlistPath, startSec, outPath } = opts;

  await execFile(
    'ffmpeg',
    [
      '-nostdin',
      '-allowed_extensions', 'ALL',
      '-protocol_whitelist', 'file,crypto,data',
      '-ss', String(startSec),
      '-t', String(PREVIEW_DURATION_SEC),
      '-i', playlistPath,
      '-c:a', 'libmp3lame',
      '-b:a', `${PREVIEW_BITRATE_KBPS}k`,
      '-movflags', '+faststart',
      '-y',
      outPath,
    ],
    EXEC_OPTS,
  ).catch((err: { stderr?: string }) => {
    throw new Error(`ffmpeg HLS preview clip failed: ${err.stderr ?? String(err)}`);
  });

  return outPath;
}
