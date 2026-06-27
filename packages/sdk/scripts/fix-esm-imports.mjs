/**
 * Post-build script: makes the ESM output Node-resolvable.
 *
 * TypeScript emits extensionless relative specifiers (`./client`), which Node's
 * ESM loader rejects. This rewrites bare relative imports to include `.js`
 * (resolving directory imports to `/index.js`). Bare-package specifiers (e.g.
 * `@syra/shared-types`) are left untouched.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const ESM_DIR = new URL('../dist/esm', import.meta.url).pathname;

async function fixSpecifier(specifier, fromFile) {
  const abs = resolve(dirname(fromFile), specifier);
  try {
    if ((await stat(abs)).isDirectory()) {
      return specifier + '/index.js';
    }
  } catch {
    // Not a directory — fall through to the file form.
  }
  return specifier + '.js';
}

async function walk(dir) {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) {
      await walk(full);
    } else if (entry.endsWith('.js')) {
      const content = await readFile(full, 'utf8');

      const barePattern = /((?:from|import)\s+['"])(\.\.?\/[^'"]+?)(?<!\.js)(?<!\.json)(['"])/g;
      const replacements = [];
      let match;
      while ((match = barePattern.exec(content)) !== null) {
        const fixed = await fixSpecifier(match[2], full);
        replacements.push({ original: match[0], replaced: match[1] + fixed + match[3] });
      }

      let updated = content;
      for (const { original, replaced } of replacements) {
        updated = updated.replace(original, replaced);
      }

      if (updated !== content) {
        await writeFile(full, updated);
      }
    }
  }
}

await walk(ESM_DIR);
console.log('ESM imports fixed');
