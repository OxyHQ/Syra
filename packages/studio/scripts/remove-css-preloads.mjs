import { readFile, writeFile } from 'node:fs/promises';

const indexHtml = new URL('../dist/index.html', import.meta.url);
const cssPreloadPattern = /<link rel="preload" href="([^"]+\.css)" as="style">\n?/g;

const html = await readFile(indexHtml, 'utf8');
const nextHtml = html.replace(cssPreloadPattern, '');

if (nextHtml !== html) {
  await writeFile(indexHtml, nextHtml);
}
