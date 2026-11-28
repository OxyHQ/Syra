#!/usr/bin/env node
/**
 * Write `_expo/static/404.html` into the web export, after `expo export`.
 *
 * `public/_headers` keeps every file under `/_expo/static/` for a year
 * (`immutable`): each is named by a hash of its bytes. A name the current deploy
 * does not have (an old tab asking for the last release's chunk, or a chunk
 * fetched just before a rollback) must therefore be a real 404, never the SPA
 * shell: `index.html` served under a script's name would be kept for a year too.
 *
 * Cloudflare Pages answers an unmatched path with the CLOSEST `404.html` and
 * falls back to `index.html` only outside a directory that has one, so this
 * file makes every miss under `/_expo/static/` a 404 (`Cache-Control:
 * no-store`) while deep links elsewhere keep the shell. Measured with
 * `wrangler pages dev`, with and without `public/_redirects`.
 *
 * Usage: node ./scripts/write-hashed-asset-404.mjs dist
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HASHED_DIR = ['_expo', 'static'];
const NOT_FOUND_HTML =
  '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found</title>\n';

const outputDir = resolve(process.argv[2] ?? 'dist');
const hashedDir = join(outputDir, ...HASHED_DIR);
// Pointed at the wrong directory this would create one nobody deploys and pass;
// the export always writes its bundles here, so its absence is a failure.
if (!existsSync(hashedDir)) {
  process.stderr.write(
    `write-hashed-asset-404: ${hashedDir} does not exist; run it after expo export, on the deploy directory.\n`,
  );
  process.exit(1);
}
mkdirSync(hashedDir, { recursive: true });
writeFileSync(join(hashedDir, '404.html'), NOT_FOUND_HTML, 'utf8');
process.stdout.write(`Wrote ${join(hashedDir, '404.html')}\n`);
