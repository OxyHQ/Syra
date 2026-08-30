#!/usr/bin/env node
/** Refuse Metro-hostile package-barrel imports in an Expo source tree. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const ROOT = resolve(process.argv[2] ?? new URL('../packages/frontend', import.meta.url).pathname);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const SKIPPED_DIRECTORIES = new Set(['.expo', 'dist', 'node_modules']);
const ROOT_VECTOR_ICON_IMPORT = /from\s+['"]@expo\/vector-icons['"]/;
const extension = (path) => path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE_EXTENSIONS.has(extension(path))) files.push(path);
  }
  return files;
}

const violations = [];
for (const file of sourceFiles(ROOT)) {
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (ROOT_VECTOR_ICON_IMPORT.test(line)) violations.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
  });
}
if (violations.length > 0) {
  console.error('Import icon families through @expo/vector-icons/<Family>; the root barrel bundles every font.\n' + violations.join('\n'));
  process.exit(1);
}
console.log(`Bundle imports: ${relative(process.cwd(), ROOT)} has no vector-icon barrel imports.`);
