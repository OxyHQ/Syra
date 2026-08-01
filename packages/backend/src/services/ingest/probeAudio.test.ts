import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFile as execFileCb, execFileSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { probeAudio } from './probeAudio';

function hasBinary(name: string): boolean {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
const MEDIA_TOOLS_AVAILABLE = ['ffmpeg', 'ffprobe'].every(hasBinary);

const execFile = promisify(execFileCb);

/** The synthesized fixture's real length; every assertion is anchored to it. */
const FIXTURE_DURATION_SEC = 7;
const FIXTURE_BITRATE_KBPS = 128;
const FIXTURE_SAMPLE_RATE = 44100;
const FIXTURE_CHANNELS = 1;

let tmpDir: string;
let mp3Path: string;
let notAudioPath: string;

beforeAll(async () => {
  if (!MEDIA_TOOLS_AVAILABLE) return;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
  mp3Path = path.join(tmpDir, 'input.mp3');
  notAudioPath = path.join(tmpDir, 'not-audio.mp3');

  await execFile('ffmpeg', [
    '-nostdin',
    '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${FIXTURE_DURATION_SEC}:sample_rate=${FIXTURE_SAMPLE_RATE}`,
    '-ac', String(FIXTURE_CHANNELS),
    '-c:a', 'libmp3lame',
    '-b:a', `${FIXTURE_BITRATE_KBPS}k`,
    mp3Path,
    '-y',
  ], { maxBuffer: 8 * 1024 * 1024 });

  // An .mp3 extension over bytes that are not audio at all — the shape a
  // hand-renamed or truncated upload takes.
  fs.writeFileSync(notAudioPath, 'this is not an audio file', 'utf8');
}, 60_000);

afterAll(() => {
  if (!MEDIA_TOOLS_AVAILABLE) return;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!MEDIA_TOOLS_AVAILABLE)('probeAudio (requires ffmpeg + ffprobe)', () => {
  it('measures the real duration of the file', async () => {
    const probed = await probeAudio(mp3Path);
    // mp3 frame padding puts the container a fraction over the requested length.
    expect(probed.durationSec).toBeGreaterThan(FIXTURE_DURATION_SEC - 0.5);
    expect(probed.durationSec).toBeLessThan(FIXTURE_DURATION_SEC + 0.5);
  });

  it('reports bitrate in kbps, not bits per second', async () => {
    const probed = await probeAudio(mp3Path);
    expect(probed.bitrateKbps).toBe(FIXTURE_BITRATE_KBPS);
  });

  it('reports the codec of the audio stream', async () => {
    const probed = await probeAudio(mp3Path);
    expect(probed.codec).toBe('mp3');
  });

  it('reports sample rate, channel count and container', async () => {
    const probed = await probeAudio(mp3Path);
    expect(probed.sampleRate).toBe(FIXTURE_SAMPLE_RATE);
    expect(probed.channels).toBe(FIXTURE_CHANNELS);
    expect(probed.container).toBe('mp3');
  });

  it('omits fields the container does not declare rather than defaulting them to 0', async () => {
    // A fabricated `sampleRate: 0` is indistinguishable from a real measurement
    // downstream, which is why every optional field is spread in conditionally.
    const probed = await probeAudio(mp3Path);
    for (const value of [probed.sampleRate, probed.channels, probed.bitrateKbps]) {
      expect(value === undefined || value > 0).toBe(true);
    }
  });

  it('rejects a file that is not decodable audio', async () => {
    await expect(probeAudio(notAudioPath)).rejects.toThrow(/ffprobe/i);
  });

  it('rejects a path that does not exist', async () => {
    await expect(probeAudio(path.join(tmpDir, 'absent.mp3'))).rejects.toThrow(/ffprobe/i);
  });
});
