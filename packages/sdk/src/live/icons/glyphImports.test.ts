import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The SDK has no eslint config (see .github/workflows/quality.yml), so this is
// its lint rule: every glyph goes through `src/live/icons/MaterialCommunityIcons`,
// which hides it from screen readers. An icon imported straight from
// `@expo/vector-icons` would be announced as its private-use code point again.
const SRC = join(import.meta.dir, '..', '..');
const WRAPPER = 'live/icons/MaterialCommunityIcons.tsx';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('icon glyph imports', () => {
  test('only the accessibility wrapper imports @expo/vector-icons', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => relative(SRC, file) !== WRAPPER)
      .filter((file) => /from\s+['"]@expo\/vector-icons/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  test('the scan actually sees the components that draw glyphs', () => {
    const users = sourceFiles(SRC).filter((file) =>
      readFileSync(file, 'utf8').includes("from '../icons/MaterialCommunityIcons'"),
    );
    expect(users.length).toBeGreaterThanOrEqual(10);
  });
});
