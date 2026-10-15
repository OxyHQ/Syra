import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'esbuild';

// zod 4 re-exports every locale it ships (`export * as locales`, ~260 KiB of
// error-message translations for 40+ languages) from each public entry. The
// binding `import { z } from 'zod'` names is itself a re-exported namespace
// object, so a bundler that sees it used must keep ALL of it — locales, JSON
// Schema conversion, the compiler — even with tree shaking on. `import * as z`
// binds the module's own namespace, whose `z.object` / `z.string` reads a
// bundler resolves to single exports, so it keeps only what the schemas use
// (plus the English locale zod registers itself). Measured with esbuild on
// `src/index.ts`: 463 KB minified before, 99 KB after.
//
// This is a bundle-level property no runtime test can see, so it is pinned in
// both forms: the import shape in source, and a real bundle of each entry. The
// bundle is esbuild's, deliberately: it keeps the whole namespace for
// `import { z }` exactly as Metro's tree shaking (Expo web) and Rollup do, so
// the assertion fails on the defect. `Bun.build` happens to see through it and
// would pass either way.

const SRC = import.meta.dir;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** A string only zod's Dutch locale contains (ASCII, so minified output cannot escape it) — any locale beyond English means all of them. */
const NON_ENGLISH_LOCALE_MARKER = 'Ongeldige invoer';
/** zod's own English message, which validation errors must keep. */
const ENGLISH_LOCALE_MARKER = 'Invalid input';

/** Peers the live engine imports; the gate is about what the SDK itself pulls in. */
const LIVE_PEERS = [
  'react',
  'react/*',
  'react-native',
  'react-native-*',
  '@oxy.so/*',
  'livekit-client',
  '@livekit/*',
  'expo-*',
  '@expo/*',
  'socket.io-client',
  'nativewind',
  '*.mp3',
];

async function bundle(entry: string, external: string[] = []): Promise<string> {
  const result = await build({
    entryPoints: [join(SRC, entry)],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    write: false,
    logLevel: 'silent',
    external,
  });
  const [output] = result.outputFiles;
  if (!output) throw new Error(`bundling ${entry} produced no output`);
  return output.text;
}

describe('zod locales stay out of consumer bundles', () => {
  it('imports zod as a module namespace, never the re-exported `z` binding', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) =>
        /import\s*\{[^}]*\bz\b[^}]*\}\s*from\s*['"]zod/.test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('the scan sees the files that build schemas', () => {
    const users = sourceFiles(SRC)
      .filter((file) => /from\s*['"]zod['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file))
      .sort();
    expect(users).toEqual(['live/validation.ts', 'schema.ts']);
  });

  it('the client entry bundles English messages and no other locale', async () => {
    const code = await bundle('index.ts');
    expect(code).toContain(ENGLISH_LOCALE_MARKER);
    expect(code).not.toContain(NON_ENGLISH_LOCALE_MARKER);
  });

  it('the live entry bundles English messages and no other locale', async () => {
    const code = await bundle('index.native.ts', LIVE_PEERS);
    expect(code).toContain(ENGLISH_LOCALE_MARKER);
    expect(code).not.toContain(NON_ENGLISH_LOCALE_MARKER);
  });
});
