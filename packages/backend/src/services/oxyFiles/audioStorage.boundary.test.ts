import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Syra's bucket has exactly two kinds of caller left, and this holds it to that:
 *
 * - AUDIO, through `services/oxyFiles/audioStorage.ts` only — the one seam where
 *   audio moves to Oxy Files once Oxy takes it (TODO(oxy-4c)). A route or service
 *   that imported the S3 layer directly would be a second place to change, and
 *   the one that gets missed.
 * - the LEGACY IMAGE read path, kept only until the image prefixes are retired:
 *   `imageAssetService.ts` (the dual read), `oxyFiles/legacyObjects.ts` (the
 *   migrations' reader), `utils/spaces.ts` (old space-image URLs) and
 *   `scripts/retireLegacyImageStorage.ts` (the retirement itself).
 *
 * Nothing else may import `services/s3Service` or `config/s3.config`.
 */

const SRC = join(__dirname, '..', '..');

const ALLOWED = new Set([
  'services/s3Service.ts',
  'services/oxyFiles/audioStorage.ts',
  'services/imageAssetService.ts',
  'services/oxyFiles/legacyObjects.ts',
  'utils/spaces.ts',
  'scripts/retireLegacyImageStorage.ts',
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

describe('the S3 layer has only its two kinds of caller', () => {
  it('is imported by the audio adapter and the legacy image path, and nothing else', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => S3_IMPORT.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path))
      .filter((path) => !ALLOWED.has(path));
    expect(offenders).toEqual([]);
  });

  it('marks the audio move in exactly one module', () => {
    const marked = sourceFiles(SRC)
      .filter((path) => readFileSync(path, 'utf8').includes('TODO(oxy-4c)'))
      .map((path) => relative(SRC, path));
    expect(marked).toEqual(['services/oxyFiles/audioStorage.ts']);
  });
});
