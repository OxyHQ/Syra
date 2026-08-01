/**
 * Encrypted HLS packaging service.
 *
 * Pipeline per track:
 *  1. Measure EBU R128 integrated loudness via ffmpeg loudnorm first pass.
 *  2. Generate a single AES-128 key (crypto.randomBytes) shared across all renditions.
 *  3. For each target bitrate: transcode (second-pass loudnorm) → fragment (mp4fragment)
 *     → package encrypted HLS segments (mp42hls, runs in cwd = per-bitrate output dir).
 *  4. Write a master.m3u8 playlist that references all variant playlists.
 *  5. Clean up intermediate files.
 */

import { execFile as execFileCb } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

const EXEC_OPTS = { maxBuffer: 32 * 1024 * 1024 } as const;

// ── Public API ──────────────────────────────────────────────────────────────

/** Catalog ladder: adaptive switching across three qualities. */
export const HLS_BITRATES_KBPS = [96, 160, 320] as const;

/**
 * Personal-locker ladder: a single rendition.
 *
 * A locker file is audible to exactly one listener, so the adaptive ladder buys
 * nothing and transcoding cost drops to a third. Everything else is identical to
 * the catalog path — same AES-128 encrypted HLS, same per-track key persisted as
 * a TrackKey — so the player needs no branch.
 */
export const LOCKER_HLS_BITRATES_KBPS = [160] as const;

export interface PackagedRendition {
  bitrateKbps: number;
  /** Relative to outputDir, e.g. "96/stream.m3u8" */
  playlistPath: string;
}

export interface PackageResult {
  outputDir: string;
  /** Relative, e.g. "master.m3u8" */
  masterPlaylistPath: string;
  renditions: PackagedRendition[];
  /** 32 lowercase hex chars = 16-byte AES-128 key */
  keyHex: string;
  /** Value placed in #EXT-X-KEY URI="..." */
  keyUri: string;
  /** EBU R128 integrated loudness of the INPUT in LUFS */
  loudnessLufs: number;
}

export interface PackageOptions {
  inputPath: string;
  outputDir: string;
  /** URI placed in each HLS key line (default: "key") */
  keyUri?: string;
  /**
   * Rendition ladder in kbps (default: `HLS_BITRATES_KBPS`). Pass
   * `LOCKER_HLS_BITRATES_KBPS` for personal-locker uploads.
   */
  bitratesKbps?: readonly number[];
}

// ── Loudnorm measurement ────────────────────────────────────────────────────

interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

async function measureLoudness(
  inputPath: string,
): Promise<{ lufs: number; measurement: LoudnormMeasurement }> {
  // ffmpeg writes loudnorm JSON to stderr; stdout is suppressed via -f null
  let stderr = '';
  try {
    const result = await execFile(
      'ffmpeg',
      [
        '-nostdin',
        '-i', inputPath,
        // `-f null` tolerates a cover-art video stream where the MP4 muxer does
        // not, so this pass was never the one that failed. Kept in step with the
        // transcode anyway: all three ffmpeg call sites should only ever see
        // audio, and an input carrying a real video stream rather than a still
        // would otherwise decode it here for nothing. Verified not to change the
        // measurement — the same file reports input_i "-24.33" either way.
        '-vn',
        '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
        '-f', 'null',
        '-',
      ],
      EXEC_OPTS,
    );
    stderr = result.stderr;
  } catch (err) {
    // execFile rejects on non-zero exit; ffmpeg exits non-zero for -f null, so
    // we still need the stderr. Re-throw only if stderr is missing.
    const execErr = err as { stderr?: string };
    if (!execErr.stderr) throw err;
    stderr = execErr.stderr;
  }

  // Extract the last JSON object from stderr
  const match = stderr.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('loudnorm: could not find JSON in ffmpeg stderr');
  }

  const parsed = JSON.parse(match[0]) as LoudnormMeasurement;
  const lufs = Number(parsed.input_i);
  if (!Number.isFinite(lufs)) {
    throw new Error(`loudnorm: unexpected input_i value: ${parsed.input_i}`);
  }

  return { lufs, measurement: parsed };
}

// ── Per-bitrate transcode + fragment + package ───────────────────────────────

async function transcodeRendition(
  inputPath: string,
  bitrateKbps: number,
  measurement: LoudnormMeasurement,
  tmpDir: string,
): Promise<string> {
  const mp4Path = path.join(tmpDir, `${bitrateKbps}.mp4`);
  const loudnormFilter = [
    'loudnorm=I=-14:TP=-1:LRA=11',
    `measured_I=${measurement.input_i}`,
    `measured_TP=${measurement.input_tp}`,
    `measured_LRA=${measurement.input_lra}`,
    `measured_thresh=${measurement.input_thresh}`,
    `offset=${measurement.target_offset}`,
    'linear=true',
  ].join(':');

  const { stderr } = await execFile(
    'ffmpeg',
    [
      '-nostdin',
      '-i', inputPath,
      // Drop every video stream. ffmpeg exposes embedded cover art (ID3 APIC,
      // FLAC PICTURE, MP4 covr) as a VIDEO stream, so default stream selection
      // picks one up and tries to encode it to H.264 alongside the audio — which
      // the MP4 muxer then rejects ("Could not find tag for codec h264"), failing
      // the whole transcode. Most real music files carry artwork, so without this
      // the pipeline fails for the common case and succeeds only for bare audio.
      '-vn',
      '-af', loudnormFilter,
      '-c:a', 'aac',
      '-b:a', `${bitrateKbps}k`,
      '-movflags', '+faststart',
      mp4Path,
      '-y',
    ],
    EXEC_OPTS,
  ).catch((err: { stderr?: string }) => {
    throw new Error(
      `ffmpeg transcode ${bitrateKbps}kbps failed: ${err.stderr ?? String(err)}`,
    );
  });

  void stderr; // ffmpeg progress goes to stderr; we don't need it after success
  return mp4Path;
}

async function fragmentMp4(mp4Path: string, tmpDir: string, bitrateKbps: number): Promise<string> {
  const fragPath = path.join(tmpDir, `${bitrateKbps}.frag.mp4`);
  await execFile('mp4fragment', [mp4Path, fragPath], EXEC_OPTS).catch(
    (err: { stderr?: string }) => {
      throw new Error(`mp4fragment ${bitrateKbps}kbps failed: ${err.stderr ?? String(err)}`);
    },
  );
  return fragPath;
}

async function packageRendition(
  fragPath: string,
  bitrateKbps: number,
  keyHex: string,
  keyUri: string,
  outputDir: string,
): Promise<PackagedRendition> {
  const renditionDir = path.join(outputDir, String(bitrateKbps));
  fs.mkdirSync(renditionDir, { recursive: true });

  // mp42hls outputs into cwd; we set cwd to the rendition dir.
  await execFile(
    'mp42hls',
    [
      '--encryption-mode', 'AES-128',
      '--encryption-key', keyHex,
      '--encryption-key-uri', keyUri,
      fragPath,
    ],
    { ...EXEC_OPTS, cwd: renditionDir },
  ).catch((err: { stderr?: string }) => {
    throw new Error(`mp42hls ${bitrateKbps}kbps failed: ${err.stderr ?? String(err)}`);
  });

  // mp42hls emits stream.m3u8 by default (confirmed via --index-filename default)
  const variantPlaylist = 'stream.m3u8';
  const playlistAbs = path.join(renditionDir, variantPlaylist);
  if (!fs.existsSync(playlistAbs)) {
    throw new Error(`mp42hls did not produce ${variantPlaylist} in ${renditionDir}`);
  }

  return {
    bitrateKbps,
    playlistPath: path.join(String(bitrateKbps), variantPlaylist),
  };
}

// ── Master playlist ──────────────────────────────────────────────────────────

function buildMasterPlaylist(renditions: PackagedRendition[]): string {
  const lines = ['#EXTM3U'];
  for (const r of renditions) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bitrateKbps * 1000},CODECS="mp4a.40.2"`);
    lines.push(r.playlistPath);
  }
  return lines.join('\n') + '\n';
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function packageToEncryptedHls(opts: PackageOptions): Promise<PackageResult> {
  const { inputPath, outputDir } = opts;
  const keyUri = opts.keyUri ?? 'key';
  const bitratesKbps = opts.bitratesKbps ?? HLS_BITRATES_KBPS;

  if (bitratesKbps.length === 0) {
    throw new Error('packageToEncryptedHls: bitratesKbps must contain at least one rendition');
  }

  fs.mkdirSync(outputDir, { recursive: true });

  // 1. Measure loudness
  const { lufs: loudnessLufs, measurement } = await measureLoudness(inputPath);

  // 2. Generate one AES-128 key for the whole track
  const keyHex = crypto.randomBytes(16).toString('hex');

  // 3. Transcode, fragment, package — one temp dir for intermediates
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-pkg-'));

  try {
    const renditions: PackagedRendition[] = [];

    for (const bitrateKbps of bitratesKbps) {
      const mp4Path = await transcodeRendition(inputPath, bitrateKbps, measurement, tmpDir);
      const fragPath = await fragmentMp4(mp4Path, tmpDir, bitrateKbps);
      const rendition = await packageRendition(fragPath, bitrateKbps, keyHex, keyUri, outputDir);
      renditions.push(rendition);
    }

    // 4. Build master playlist
    const masterContent = buildMasterPlaylist(renditions);
    const masterPlaylistPath = 'master.m3u8';
    fs.writeFileSync(path.join(outputDir, masterPlaylistPath), masterContent, 'utf8');

    return {
      outputDir,
      masterPlaylistPath,
      renditions,
      keyHex,
      keyUri,
      loudnessLufs,
    };
  } finally {
    // 5. Clean up intermediates
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
