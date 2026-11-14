/**
 * Joining an episode's spoken lines into one MP3, with ffmpeg (in the API
 * image beside the ingest tools). Lines are joined in memory order and never
 * stored on their own: the only durable copy is the episode's source audio.
 *
 * The duration is MEASURED by `probeAudio`, the same ffprobe authority every
 * upload goes through, never inferred from the byte length: it is what the
 * episode list and the RSS feed show forever.
 */

import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { probeAudio } from '../../ingest/probeAudio';

const execFile = promisify(execFileCb);

/** ffmpeg's progress output for a long episode outgrows the 1 MB default. */
const EXEC_OPTS = { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 } as const;

export interface AssembledAudio {
  readonly audio: Buffer;
  readonly durationSec: number;
}

/**
 * One file from the lines, re-encoded to one bitrate and one loudness (lines
 * from one model still differ in level, which is the most audible defect).
 */
export async function assembleEpisodeAudio(lines: readonly Buffer[]): Promise<AssembledAudio> {
  if (lines.length === 0) throw new Error('assembleEpisodeAudio: no audio to join');
  const directory = await mkdtemp(join(tmpdir(), 'episode-generation-'));
  try {
    const paths: string[] = [];
    for (const [index, line] of lines.entries()) {
      const path = join(directory, `line-${String(index).padStart(4, '0')}.mp3`);
      await writeFile(path, line);
      paths.push(path);
    }
    // Every path is in a directory this process just created, so `-safe 0` is
    // never handed a name that came from a model or a person.
    const listPath = join(directory, 'lines.txt');
    await writeFile(listPath, paths.map((path) => `file '${path}'`).join('\n'));
    const outputPath = join(directory, 'episode.mp3');
    await execFile(
      'ffmpeg',
      [
        '-nostdin',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-vn',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '128k',
        '-ar',
        '44100',
        '-ac',
        '1',
        '-filter:a',
        'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-y',
        outputPath,
      ],
      EXEC_OPTS,
    );
    const probed = await probeAudio(outputPath);
    return { audio: await readFile(outputPath), durationSec: Math.round(probed.durationSec) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
