/**
 * @jest-environment node
 *
 * `public/_headers` keeps `/_expo/static/*` for a year, so a hashed name the
 * deploy lacks must be a 404, not the SPA shell (which the rule would then keep
 * a year under a script's name). Pages answers a miss with the closest
 * `404.html`; `scripts/write-hashed-asset-404.mjs` writes it after the export.
 * These cases pin that the file is written, that every web build runs it, and
 * that it refuses a directory the export did not write.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..');
const script = join(root, 'scripts', 'write-hashed-asset-404.mjs');

function run(dir: string) {
  return spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
}

describe('hashed-asset 404', () => {
  it('writes _expo/static/404.html beside the bundles, leaving them untouched', () => {
    const dist = mkdtempSync(join(tmpdir(), 'syra-dist-'));
    mkdirSync(join(dist, '_expo', 'static', 'js', 'web'), { recursive: true });
    const bundle = join(dist, '_expo', 'static', 'js', 'web', 'entry-0123456789abcdef.js');
    writeFileSync(bundle, 'console.log(1)');
    const result = run(dist);
    expect(result.status).toBe(0);
    const notFound = readFileSync(join(dist, '_expo', 'static', '404.html'), 'utf8');
    expect(notFound).toContain('<title>Not found</title>');
    expect(readFileSync(bundle, 'utf8')).toBe('console.log(1)');
  });

  it('refuses a directory the export did not write', () => {
    const empty = mkdtempSync(join(tmpdir(), 'syra-dist-'));
    const result = run(empty);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(empty, '_expo', 'static', '404.html'))).toBe(false);
  });

  it('every web build writes it, and the immutable rule is still the one it protects', () => {
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<
      string,
      string
    >;
    for (const name of ['build', 'build-web', 'build-web:prod']) {
      expect(scripts[name]).toMatch(
        /expo export --platform web .*&& node \.\/scripts\/write-hashed-asset-404\.mjs dist/,
      );
    }
    const headers = readFileSync(join(root, 'public', '_headers'), 'utf8');
    expect(headers).toMatch(
      /\/_expo\/static\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/,
    );
  });
});
