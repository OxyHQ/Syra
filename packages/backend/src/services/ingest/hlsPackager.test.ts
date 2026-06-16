import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFile as execFileCb, execFileSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { packageToEncryptedHls, HLS_BITRATES_KBPS } from './hlsPackager';

function hasBinary(name: string): boolean {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
const MEDIA_TOOLS_AVAILABLE = ['ffmpeg', 'mp42hls', 'mp4fragment'].every(hasBinary);

const execFile = promisify(execFileCb);

let tmpInputDir: string;
let tmpOutputDir: string;
let inputPath: string;

beforeAll(async () => {
  if (!MEDIA_TOOLS_AVAILABLE) return;
  tmpInputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-test-in-'));
  tmpOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-test-out-'));
  inputPath = path.join(tmpInputDir, 'input.m4a');

  // Synthesize a real 5-second audio file using ffmpeg
  await execFile('ffmpeg', [
    '-nostdin',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=5',
    '-c:a', 'aac',
    '-b:a', '192k',
    inputPath,
    '-y',
  ], { maxBuffer: 8 * 1024 * 1024 });
}, 60_000);

afterAll(() => {
  if (!MEDIA_TOOLS_AVAILABLE) return;
  fs.rmSync(tmpInputDir, { recursive: true, force: true });
  fs.rmSync(tmpOutputDir, { recursive: true, force: true });
});

describe.skipIf(!MEDIA_TOOLS_AVAILABLE)('packageToEncryptedHls (requires ffmpeg + Bento4)', () => {
  // Single shared result — packageToEncryptedHls is called once; sub-tests inspect it.
  let result: Awaited<ReturnType<typeof packageToEncryptedHls>>;

  beforeAll(async () => {
    result = await packageToEncryptedHls({
      inputPath,
      outputDir: tmpOutputDir,
      keyUri: 'key',
    });
  }, 120_000);

  it('returns 3 renditions with the expected bitrates', () => {
    expect(result.renditions).toHaveLength(3);
    const bitrates = result.renditions.map((r) => r.bitrateKbps);
    expect(bitrates).toEqual([...HLS_BITRATES_KBPS]);
  });

  it('master.m3u8 exists and contains 3 EXT-X-STREAM-INF lines and each variant URI', () => {
    const masterPath = path.join(result.outputDir, result.masterPlaylistPath);
    expect(fs.existsSync(masterPath)).toBe(true);

    const content = fs.readFileSync(masterPath, 'utf8');
    const streamInfCount = (content.match(/#EXT-X-STREAM-INF/g) ?? []).length;
    expect(streamInfCount).toBe(3);

    for (const rendition of result.renditions) {
      expect(content).toContain(rendition.playlistPath);
    }
  });

  it('each variant playlist exists and contains #EXT-X-KEY:METHOD=AES-128 with correct URI', () => {
    for (const rendition of result.renditions) {
      const playlistPath = path.join(result.outputDir, rendition.playlistPath);
      expect(fs.existsSync(playlistPath)).toBe(true);

      const content = fs.readFileSync(playlistPath, 'utf8');
      expect(content).toContain('#EXT-X-KEY:METHOD=AES-128');
      expect(content).toContain(`URI="${result.keyUri}"`);
    }
  });

  it('at least one encrypted .ts segment exists per rendition', () => {
    for (const rendition of result.renditions) {
      const renditionDir = path.join(result.outputDir, path.dirname(rendition.playlistPath));
      const segments = fs.readdirSync(renditionDir).filter((f) => f.endsWith('.ts'));
      expect(segments.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('keyHex is a 32-char lowercase hex string (16 bytes AES-128)', () => {
    expect(result.keyHex).toMatch(/^[0-9a-f]{32}$/);
  });

  it('loudnessLufs is a finite number', () => {
    expect(Number.isFinite(result.loudnessLufs)).toBe(true);
  });

  it('all renditions share a single key', () => {
    // Same keyHex is placed in every variant playlist's EXT-X-KEY line.
    // We can't read the key back from the playlist (it's binary), but we
    // assert the keyUri is identical across playlists — the contract that
    // one key endpoint serves all renditions.
    for (const rendition of result.renditions) {
      const content = fs.readFileSync(
        path.join(result.outputDir, rendition.playlistPath),
        'utf8',
      );
      expect(content).toContain(`URI="${result.keyUri}"`);
    }
  });
});
