import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = import.meta.dir;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('@oxy.so/services entry', () => {
  it('the SDK reads Oxy through the lean ui/client entry, never the root barrel', () => {
    // The root re-exports every sign-in panel (and a QR encoder); a bundler
    // without tree-shaking ships them to every app that renders a room.
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((file) =>
      /from\s+['"]@oxy\.so\/services['"]/.test(readFileSync(file, 'utf8').replace(/^\s*import\s+type[^;]*;/gm, '')),
    );
    expect(offenders).toEqual([]);
  });
});
