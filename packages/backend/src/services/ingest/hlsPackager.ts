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

export const HLS_BITRATES_KBPS = [96, 160, 320] as const;

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

  fs.mkdirSync(outputDir, { recursive: true });

  // 1. Measure loudness
  const { lufs: loudnessLufs, measurement } = await measureLoudness(inputPath);

  // 2. Generate one AES-128 key for the whole track
  const keyHex = crypto.randomBytes(16).toString('hex');

  // 3. Transcode, fragment, package — one temp dir for intermediates
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-pkg-'));

  try {
    const renditions: PackagedRendition[] = [];

    for (const bitrateKbps of HLS_BITRATES_KBPS) {
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
