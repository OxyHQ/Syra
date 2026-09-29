import { mkdirSync, writeFileSync } from 'node:fs';

// Keep the server CommonJS build and identify the browser build as ESM.
mkdirSync(new URL('../dist/browser/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/browser/package.json', import.meta.url), JSON.stringify({ type: 'module' }) + '\n');
