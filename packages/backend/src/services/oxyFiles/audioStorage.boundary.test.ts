import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Syra's bucket holds audio only, and has one caller: `services/oxyFiles/audioStorage.ts`
 * — the one seam that decides whether audio is stored in and played from Oxy
 * Files or the bucket (ADR 0043 stage 4c). A route or service that imported the
 * S3 layer, or the Oxy half of the seam (`oxyAudio.ts`), directly would be a
 * second place to change, and the one that gets missed. Images are Oxy files
 * and never touch the bucket.
 *
 * Nothing else may import `services/s3Service` or `config/s3.config`.
 */

const SRC = join(__dirname, '..', '..');

const ALLOWED = new Set([
  'services/s3Service.ts',
  'services/oxyFiles/audioStorage.ts',
  'config/s3.config.ts',
]);

const S3_IMPORT =
  /from\s+['"][^'"]*(?:services\/s3Service|\/s3Service|config\/s3\.config|\/s3\.config)['"]/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'test' || entry === '__fixtures__') continue;
      out.push(...sourceFiles(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('the S3 layer has only the audio seam as its caller', () => {
  it('is imported by the audio adapter, and nothing else', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => S3_IMPORT.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path))
      .filter((path) => !ALLOWED.has(path));
    expect(offenders).toEqual([]);
  });

  it('reaches the Oxy half of the audio seam only through the seam', () => {
    const OXY_AUDIO_IMPORT = /from\s+['"][^'"]*oxyFiles\/oxyAudio['"]|from\s+['"]\.\/oxyAudio['"]/;
    const offenders = sourceFiles(SRC)
      .filter((path) => OXY_AUDIO_IMPORT.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path))
      .filter((path) => path !== 'services/oxyFiles/audioStorage.ts');
    expect(offenders).toEqual([]);
  });

  it('leaves no audio waiting on Oxy: stage 4c is adopted, not deferred', () => {
    const marked = sourceFiles(join(SRC, '..'))
      .filter((path) => /TODO\(oxy-4[bc]\)/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path));
    expect(marked).toEqual([]);
  });
});
