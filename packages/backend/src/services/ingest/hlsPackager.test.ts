import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFile as execFileCb, execFileSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  packageToEncryptedHls,
  HLS_BITRATES_KBPS,
  LOCKER_HLS_BITRATES_KBPS,
} from './hlsPackager';

function hasBinary(name: string): boolean {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
const MEDIA_TOOLS_AVAILABLE = ['ffmpeg', 'mp42hls', 'mp4fragment'].every(hasBinary);

const execFile = promisify(execFileCb);

let tmpInputDir: string;
let tmpOutputDir: string;
let tmpLockerOutputDir: string;
let inputPath: string;

beforeAll(async () => {
  if (!MEDIA_TOOLS_AVAILABLE) return;
  tmpInputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-test-in-'));
  tmpOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-test-out-'));
  tmpLockerOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-test-locker-'));
  inputPath = path.join(tmpInputDir, 'input.m4a');
  const coverPath = path.join(tmpInputDir, 'cover.jpg');

  /**
   * The fixture carries EMBEDDED COVER ART, and that is the point of it.
   *
   * ffmpeg exposes artwork as a video stream, so the packager's transcode used
   * to pick it up and try to encode it to H.264 next to the audio, which the MP4
   * muxer rejects and the whole conversion fails. A bare synthesized tone — what
   * this fixture used to be — has no attached picture, so the failing branch was
   * never executed and the tests passed against a pipeline that was broken for
   * the majority of real music files. Whatever else changes here, the input must
   * keep its picture stream; `attached picture` below is the guard for that.
   */
  await execFile('ffmpeg', [
    '-nostdin',
    '-f', 'lavfi',
    '-i', 'color=c=red:s=64x64:d=1',
    '-frames:v', '1',
    coverPath,
    '-y',
  ], { maxBuffer: 8 * 1024 * 1024 });

  await execFile('ffmpeg', [
    '-nostdin',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=5',
    '-i', coverPath,
    '-map', '0:a',
    '-map', '1:v',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-c:v', 'mjpeg',
    '-disposition:v', 'attached_pic',
    inputPath,
    '-y',
  ], { maxBuffer: 8 * 1024 * 1024 });
}, 60_000);

/** The distinct codec types ffprobe reports for `file`, e.g. `['audio']`. */
async function streamTypes(file: string, extraArgs: string[] = []): Promise<string[]> {
  const { stdout } = await execFile('ffprobe', [
    '-v', 'error',
    ...extraArgs,
    '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0',
    file,
  ]);
  const types = stdout
    .split('\n')
    .map((line) => line.replace(/,\s*$/, '').trim())
    .filter(Boolean);
  return [...new Set(types)].sort();
}

/**
 * Codec types inside a PACKAGED rendition, read through its encryption.
 *
 * The segments are AES-128 encrypted, so ffprobing one directly returns
 * "Invalid data found when processing input" — it cannot see the stream layout
 * at all, which makes a direct probe useless as a check rather than merely
 * awkward. Writing the key next to the playlist (the `#EXT-X-KEY URI="key"` the
 * packager emits is relative) and letting ffmpeg decrypt is the only way to
 * assert on what actually ended up in the media. Same mechanism
 * `generatePreviewClipFromHls` uses in production.
 */
async function renditionStreamTypes(
  outputDir: string,
  playlistPath: string,
  keyHex: string,
): Promise<string[]> {
  const renditionDir = path.join(outputDir, path.dirname(playlistPath));
  fs.writeFileSync(path.join(renditionDir, 'key'), Buffer.from(keyHex, 'hex'));
  return streamTypes(path.join(outputDir, playlistPath), [
    '-allowed_extensions', 'ALL',
    '-protocol_whitelist', 'file,crypto,data',
  ]);
}

afterAll(() => {
  if (!MEDIA_TOOLS_AVAILABLE) return;
  fs.rmSync(tmpInputDir, { recursive: true, force: true });
  fs.rmSync(tmpOutputDir, { recursive: true, force: true });
  fs.rmSync(tmpLockerOutputDir, { recursive: true, force: true });
});

describe('packageToEncryptedHls ladder validation', () => {
  it('rejects an empty ladder instead of producing a playlist with no renditions', async () => {
    await expect(
      packageToEncryptedHls({
        inputPath: '/nonexistent/input.m4a',
        outputDir: '/nonexistent/output',
        bitratesKbps: [],
      }),
    ).rejects.toThrow(/at least one rendition/);
  });
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

  it('the fixture really does carry embedded cover art', async () => {
    // Vacuity floor. Every assertion in this describe is only meaningful because
    // the input has a picture stream; if a future edit synthesizes a bare tone
    // again, the cover-art regression becomes invisible exactly as it was before.
    expect(await streamTypes(inputPath)).toEqual(['audio', 'video']);
  }, 30_000);

  it('every rendition contains audio and ONLY audio — the artwork is dropped, not encoded', async () => {
    /**
     * The direct guard on the cover-art bug, asserted on the decrypted media
     * rather than inferred. Without `-vn` ffmpeg encodes the artwork to H.264
     * beside the audio and the MP4 muxer rejects the pair, so in practice this
     * fails earlier — nothing is produced at all. Asserting the stream layout
     * anyway covers the variant where a muxer ACCEPTS the video stream (MP3 does,
     * which is why the preview path silently carried artwork for months) and the
     * regression would otherwise ship a spurious stream in every segment.
     */
    for (const rendition of result.renditions) {
      const types = await renditionStreamTypes(
        result.outputDir,
        rendition.playlistPath,
        result.keyHex,
      );
      expect(types).toEqual(['audio']);
    }
  }, 60_000);

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

  it('the locker ladder produces exactly one 160k rendition, still AES-128 encrypted', async () => {
    const locker = await packageToEncryptedHls({
      inputPath,
      outputDir: tmpLockerOutputDir,
      keyUri: 'key',
      bitratesKbps: LOCKER_HLS_BITRATES_KBPS,
    });

    expect(locker.renditions).toHaveLength(1);
    expect(locker.renditions.map((r) => r.bitrateKbps)).toEqual([...LOCKER_HLS_BITRATES_KBPS]);

    // Same encrypted-HLS contract as the catalog path — only the ladder differs.
    const playlist = fs.readFileSync(
      path.join(locker.outputDir, locker.renditions[0].playlistPath),
      'utf8',
    );
    expect(playlist).toContain('#EXT-X-KEY:METHOD=AES-128');
    expect(locker.keyHex).toMatch(/^[0-9a-f]{32}$/);

    const master = fs.readFileSync(path.join(locker.outputDir, locker.masterPlaylistPath), 'utf8');
    expect((master.match(/#EXT-X-STREAM-INF/g) ?? []).length).toBe(1);

    // The catalog default is untouched by the new parameter.
    expect(result.renditions).toHaveLength(HLS_BITRATES_KBPS.length);
  }, 120_000);

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
