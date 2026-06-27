import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFile as execFileCb, execFileSync } from 'child_process';
import crypto from 'crypto';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generatePreviewClip,
  generatePreviewClipFromHls,
  PREVIEW_DURATION_SEC,
} from './previewClip';

function hasBinary(name: string): boolean {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
const MEDIA_TOOLS_AVAILABLE = ['ffmpeg', 'ffprobe'].every(hasBinary);
// Bento4 (mp42hls/mp4fragment) is needed to package a real encrypted HLS source.
const HLS_TOOLS_AVAILABLE = ['ffmpeg', 'ffprobe', 'mp42hls', 'mp4fragment'].every(hasBinary);

const execFile = promisify(execFileCb);

async function probeDurationSec(file: string): Promise<number> {
  const { stdout } = await execFile('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    file,
  ]);
  return Number(stdout.trim());
}

async function probeCodec(file: string): Promise<string> {
  const { stdout } = await execFile('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'csv=p=0',
    file,
  ]);
  return stdout.trim();
}

let tmpDir: string;
let inputPath: string;

beforeAll(async () => {
  if (!MEDIA_TOOLS_AVAILABLE) return;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-test-'));
  inputPath = path.join(tmpDir, 'input.mp3');

  // Synthesize a real 40-second audio file so a 30s clip is fully exercised.
  await execFile('ffmpeg', [
    '-nostdin',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=40',
    '-c:a', 'libmp3lame',
    '-b:a', '192k',
    inputPath,
    '-y',
  ], { maxBuffer: 8 * 1024 * 1024 });
}, 60_000);

afterAll(() => {
  if (!MEDIA_TOOLS_AVAILABLE) return;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!MEDIA_TOOLS_AVAILABLE)('generatePreviewClip (requires ffmpeg)', () => {
  it('produces a ~30s MP3 clip from start=0', async () => {
    const outPath = path.join(tmpDir, 'clip-0.mp3');
    const result = await generatePreviewClip({ inputPath, startSec: 0, outPath });

    expect(result).toBe(outPath);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(await probeCodec(outPath)).toBe('mp3');

    const duration = await probeDurationSec(outPath);
    // -t caps the clip at PREVIEW_DURATION_SEC (allow muxer rounding slack).
    expect(duration).toBeGreaterThan(PREVIEW_DURATION_SEC - 1);
    expect(duration).toBeLessThan(PREVIEW_DURATION_SEC + 1);
  }, 60_000);

  it('honours the start offset (start=35 on a 40s source → ~5s tail)', async () => {
    const outPath = path.join(tmpDir, 'clip-35.mp3');
    await generatePreviewClip({ inputPath, startSec: 35, outPath });

    const duration = await probeDurationSec(outPath);
    // Source is 40s; seeking to 35s leaves only ~5s of audio.
    expect(duration).toBeGreaterThan(3);
    expect(duration).toBeLessThan(7);
  }, 60_000);

  it('rejects with ffmpeg stderr when the input path does not exist', async () => {
    const outPath = path.join(tmpDir, 'clip-missing.mp3');
    await expect(
      generatePreviewClip({ inputPath: path.join(tmpDir, 'nope.mp3'), startSec: 0, outPath }),
    ).rejects.toThrow(/ffmpeg preview clip failed/);
  });
});

// ── HLS-source path (encrypted, mirrors the real ingest packaging) ──────────────

describe.skipIf(!HLS_TOOLS_AVAILABLE)('generatePreviewClipFromHls (requires ffmpeg + Bento4)', () => {
  let hlsDir: string;
  let playlistPath: string;

  beforeAll(async () => {
    if (!HLS_TOOLS_AVAILABLE) return;
    hlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-hls-test-'));
    const srcMp4 = path.join(hlsDir, 'src.mp4');
    const fragMp4 = path.join(hlsDir, 'frag.mp4');
    const renditionDir = path.join(hlsDir, '96');
    fs.mkdirSync(renditionDir, { recursive: true });

    // 1. Synthesize 40s aac mp4, 2. fragment (same chain as hlsPackager).
    await execFile('ffmpeg', [
      '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', srcMp4, '-y',
    ], { maxBuffer: 8 * 1024 * 1024 });
    await execFile('mp4fragment', [srcMp4, fragMp4]);

    // 3. Package encrypted AES-128 HLS (same flags as hlsPackager.packageRendition).
    const keyHex = crypto.randomBytes(16).toString('hex');
    await execFile('mp42hls', [
      '--encryption-mode', 'AES-128',
      '--encryption-key', keyHex,
      '--encryption-key-uri', 'key',
      fragMp4,
    ], { cwd: renditionDir });

    // 4. Materialize exactly like previewService.storePreviewFromHls: write the key
    //    bytes locally and rewrite the EXT-X-KEY URI to point at it.
    fs.writeFileSync(path.join(renditionDir, 'key.bin'), Buffer.from(keyHex, 'hex'));
    const stored = fs.readFileSync(path.join(renditionDir, 'stream.m3u8'), 'utf8');
    playlistPath = path.join(renditionDir, 'index.m3u8');
    fs.writeFileSync(playlistPath, stored.replace(/URI="[^"]*"/, 'URI="key.bin"'));
  }, 120_000);

  afterAll(() => {
    if (!HLS_TOOLS_AVAILABLE) return;
    fs.rmSync(hlsDir, { recursive: true, force: true });
  });

  it('decrypts the HLS and produces a ~30s MP3 clip from start=0', async () => {
    const outPath = path.join(hlsDir, 'hls-clip-0.mp3');
    const result = await generatePreviewClipFromHls({ playlistPath, startSec: 0, outPath });

    expect(result).toBe(outPath);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(await probeCodec(outPath)).toBe('mp3');

    const duration = await probeDurationSec(outPath);
    expect(duration).toBeGreaterThan(PREVIEW_DURATION_SEC - 1);
    expect(duration).toBeLessThan(PREVIEW_DURATION_SEC + 1);
  }, 60_000);

  it('honours the start offset on the decrypted HLS (start=15 on 40s → ~25s)', async () => {
    const outPath = path.join(hlsDir, 'hls-clip-15.mp3');
    await generatePreviewClipFromHls({ playlistPath, startSec: 15, outPath });

    const duration = await probeDurationSec(outPath);
    expect(duration).toBeGreaterThan(23);
    expect(duration).toBeLessThan(27);
  }, 60_000);
});
