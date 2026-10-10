#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
const DIST = resolve(
  process.argv[2] ?? new URL('../packages/frontend/dist', import.meta.url).pathname,
);
const BUDGET_FILE = resolve(
  process.argv[3] ?? new URL('../performance-budgets.json', import.meta.url).pathname,
);
const INVENTORY_FILE = resolve(
  process.argv[4] ?? resolve(dirname(DIST), '.expo/web-bundle-inventory.json'),
);
const { frontendWeb: budget } = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
const inventory = JSON.parse(readFileSync(INVENTORY_FILE, 'utf8'));
const html = readFileSync(resolve(DIST, 'index.html'), 'utf8');
const initial = new Set(
  [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js)["'][^>]*>/g)].map((match) =>
    decodeURIComponent(match[1]).replace(/^\//, ''),
  ),
);
if (initial.size === 0) throw new Error('No initial script entries found in index.html');
const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)],
  );
const metrics = {
  totalBytes: 0,
  initialJavaScriptBytes: 0,
  initialJavaScriptGzipBytes: 0,
  translationBytes: 0,
  translationGzipBytes: 0,
  otherJavaScriptBytes: 0,
  otherJavaScriptGzipBytes: 0,
  nonJavaScriptBytes: 0,
  fontBytes: 0,
};
const seen = new Set();
for (const file of files(DIST)) {
  const size = statSync(file).size;
  metrics.totalBytes += size;
  if (file.endsWith('.js')) {
    const name = relative(DIST, file),
      bytes = readFileSync(file),
      record = inventory[name];
    if (!record || record.sha256 !== createHash('sha256').update(bytes).digest('hex'))
      throw new Error(`Missing or stale source-map inventory for ${name}`);
    seen.add(name);
    // An initial script is always charged to initial, even if it contains a locale.
    const kind = initial.has(name)
      ? 'initialJavaScript'
      : record.translation
        ? 'translation'
        : 'otherJavaScript';
    metrics[`${kind}Bytes`] += size;
    metrics[`${kind}GzipBytes`] += gzipSync(bytes).length;
  } else metrics.nonJavaScriptBytes += size;
  if (/\.(?:otf|ttf|woff2?)$/.test(file)) metrics.fontBytes += size;
}
for (const entry of initial)
  if (!seen.has(entry)) throw new Error(`Missing initial script ${entry}`);
for (const entry of Object.keys(inventory))
  if (!seen.has(entry)) throw new Error(`Stale inventory entry ${entry}`);
const limits = [
  'initialJavaScriptBytes',
  'initialJavaScriptGzipBytes',
  'translationBytes',
  'translationGzipBytes',
  'otherJavaScriptBytes',
  'otherJavaScriptGzipBytes',
  'nonJavaScriptBytes',
  'fontBytes',
];
const failures = limits.filter(
  (metric) => !Number.isFinite(budget[metric]) || metrics[metric] > budget[metric],
);
console.log(JSON.stringify({ metrics, budget }, null, 2));
for (const metric of failures)
  console.error(`${metric} is ${metrics[metric]} bytes; budget ${budget[metric]}.`);
if (failures.length) process.exit(1);
console.log(
  'Web export is within its initial, deferred translation, other code and asset budgets.',
);
