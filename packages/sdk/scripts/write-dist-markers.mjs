/**
 * Post-build: write dual-package `type` markers so Node resolves the format of
 * each output unambiguously, regardless of the root package's `type` field or
 * the Node version's module-detection heuristics.
 *
 *   dist/esm/package.json → { "type": "module" }
 *   dist/cjs/package.json → { "type": "commonjs" }
 */

import { mkdir, writeFile } from 'node:fs/promises';

const distURL = new URL('../dist/', import.meta.url);

async function writeMarker(subdir, type) {
  const dir = new URL(`${subdir}/`, distURL);
  await mkdir(dir, { recursive: true });
  await writeFile(new URL('package.json', dir), `${JSON.stringify({ type }, null, 2)}\n`);
}

await writeMarker('esm', 'module');
await writeMarker('cjs', 'commonjs');
console.log('dist markers written');
