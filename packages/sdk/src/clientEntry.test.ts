import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('@syra.fm/sdk/client', () => {
  it('resolves to the base entry under every condition, never the live engine', () => {
    const entry = pkg.exports['./client'];
    expect(entry['react-native']).toBe('./src/index.ts');
    expect(entry.import.default).toBe('./lib/module/index.js');
    expect(entry.require.default).toBe('./lib/commonjs/index.js');
    expect(entry.default).toBe('./lib/module/index.js');
    // No `browser` condition: that one routes the root export to the live
    // engine, and this entry exists to leave it out.
    expect(entry.browser).toBeUndefined();
  });

  it('the base entry does not reach the live engine', () => {
    const source = readFileSync(join(root, 'src/index.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/live/);
  });
});
