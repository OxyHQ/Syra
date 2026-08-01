/**
 * ffprobe wrapper — the single authority for a source file's real duration,
 * bitrate and codec.
 *
 * Duration used to be a text field a human typed into the studio upload form and
 * the backend accepted on trust (`parseFloat(req.body.duration) > 0`). It is now
 * always measured from the file: the uploader cannot make a 30-second clip claim
 * to be 5 minutes, and every track gets a duration even when the client omits it.
 *
 * ffprobe ships with ffmpeg, which the runtime image already installs, so this
 * adds no new dependency.
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

/** ffprobe JSON on stdout stays small; this only guards against a runaway file. */
const EXEC_OPTS = { maxBuffer: 4 * 1024 * 1024 } as const;

export interface ProbedAudio {
  /** Duration in seconds, as measured by ffprobe. Always finite and > 0. */
  durationSec: number;
  /**
   * Average bitrate in kbps, rounded. Absent when neither the audio stream nor
   * the container declares one (some WAV/lossless containers do not).
   */
  bitrateKbps?: number;
  /** Codec of the first audio stream, e.g. "mp3", "flac", "aac". */
  codec?: string;
  /** Sample rate in Hz, e.g. 44100. */
  sampleRate?: number;
  /** Channel count, e.g. 2 for stereo. */
  channels?: number;
  /**
   * Container format as ffprobe names it. Note this is ffmpeg's demuxer family
   * rather than a single extension, so an m4a reports the whole list
   * ("mov,mp4,m4a,3gp,3g2,mj2") while an mp3 reports just "mp3". Passed through
   * verbatim rather than narrowed, because guessing which member of the family a
   * file really is would be inventing information the probe did not give us.
   */
  container?: string;
}

// ── ffprobe JSON shape ───────────────────────────────────────────────────────
// Only the fields we read are declared. Everything is optional because ffprobe
// omits whatever the container does not carry, and every value below is
// validated before use rather than trusted.

interface FfprobeStream {
  codec_name?: string;
  codec_type?: string;
  bit_rate?: string;
  duration?: string;
  sample_rate?: string;
  /** ffprobe emits this one as a JSON number, unlike the fields above. */
  channels?: number;
}

interface FfprobeFormat {
  duration?: string;
  bit_rate?: string;
  format_name?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

/** Parse an ffprobe numeric field, which is always a decimal string or absent. */
function toPositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Probe a local audio file.
 *
 * @throws when ffprobe fails, emits unparseable JSON, or the file carries no
 *         usable duration — all of which mean the file is not ingestable, so
 *         failing loudly here is better than persisting a zero-duration track.
 */
export async function probeAudio(inputPath: string): Promise<ProbedAudio> {
  let stdout: string;
  try {
    const result = await execFile(
      'ffprobe',
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        '-select_streams', 'a:0',
        inputPath,
      ],
      EXEC_OPTS,
    );
    stdout = result.stdout;
  } catch (err) {
    const execErr = err as { stderr?: string };
    throw new Error(`ffprobe failed for ${inputPath}: ${execErr.stderr ?? String(err)}`);
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch (err) {
    throw new Error(`ffprobe: could not parse JSON output for ${inputPath}: ${String(err)}`);
  }

  const stream = parsed.streams?.find((s) => s.codec_type === 'audio') ?? parsed.streams?.[0];

  // The container duration is the more reliable of the two (a stream may declare
  // none), but a stream duration is preferred when present because it excludes
  // container padding.
  const durationSec = toPositiveNumber(stream?.duration) ?? toPositiveNumber(parsed.format?.duration);
  if (durationSec === undefined) {
    throw new Error(`ffprobe: no usable duration for ${inputPath}`);
  }

  const bitsPerSecond = toPositiveNumber(stream?.bit_rate) ?? toPositiveNumber(parsed.format?.bit_rate);
  const sampleRate = toPositiveNumber(stream?.sample_rate);
  const channels =
    typeof stream?.channels === 'number' && Number.isFinite(stream.channels) && stream.channels > 0
      ? stream.channels
      : undefined;

  // Every field below is omitted rather than defaulted when the container does
  // not declare it — a fabricated 0 Hz or 0 channels reads as real data.
  return {
    durationSec,
    ...(bitsPerSecond !== undefined && { bitrateKbps: Math.round(bitsPerSecond / 1000) }),
    ...(stream?.codec_name !== undefined && { codec: stream.codec_name }),
    ...(sampleRate !== undefined && { sampleRate }),
    ...(channels !== undefined && { channels }),
    ...(parsed.format?.format_name !== undefined && { container: parsed.format.format_name }),
  };
}
