/**
 * No file may hold half of the catalog port.
 *
 * The Mongoose modules under `utils/` and the drizzle modules under
 * `db/catalog/` deliberately coexist for the length of Task 10: the old ones
 * keep serving every call site that has not moved, and each is DELETED when its
 * last caller leaves in Task 10c. That shape makes exactly one bad state
 * reachable — a single file that has switched some of its reads to Postgres and
 * left the rest on Mongo — and `tsc` cannot see it, for the same reason it could
 * not see a drizzle `SQL` handed to `TrackModel.find()`: Mongoose 9's
 * `QueryFilter<T>` is an all-optional mapped type, so that call compiles clean
 * and silently matches nothing.
 *
 * A type error was never going to catch this, so it is checked here instead.
 *
 * ## What counts as a violation
 *
 * Importing a PORTED symbol from an old module while also importing anything
 * from `db/catalog/`. Ported means "has a drizzle counterpart with the same
 * name", which is what makes holding both a half-port rather than a coincidence.
 *
 * `getRequestUserId` is the one exception and it is listed by identity, not by
 * pattern: it reads an id off an Express request and has nothing to do with
 * either database, so a controller that has moved its queries but still calls it
 * is not half-ported. It has no drizzle counterpart because it does not belong
 * in `db/` at all. Task 10c gives it a home of its own when
 * `utils/catalogVisibility.ts` is deleted, at which point
 * {@link UNPORTED_SYMBOLS} must be empty — asserted below, so the exception
 * cannot outlive its reason.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'bun:test';

const SOURCE_DIR = join(__dirname, '..', '..', '..');

/**
 * The Mongoose modules Task 10 replaces, by the suffix their import specifiers
 * end with. Every import of these in this repo is relative, so a suffix match is
 * exact — `'../utils/musicHelpers'` and `'./musicHelpers'` both land, and
 * nothing else does.
 */
const OLD_MODULES = [
  'utils/catalogVisibility',
  'utils/playableContainers',
  'utils/musicHelpers',
  'utils/catalogOwnership',
] as const;

/** The drizzle replacements, by the fragment their specifiers contain. */
const NEW_MODULE_FRAGMENT = 'db/catalog/';

/**
 * Symbols an old module exports that have NO drizzle counterpart, so importing
 * one alongside the new modules is not a half-port. Keyed by module suffix.
 *
 * MUST be empty by the end of Task 10c — see this file's doc comment and the
 * final test below.
 */
const UNPORTED_SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  'utils/catalogVisibility': ['getRequestUserId'],
};

/** Blank out comments, preserving line structure, so prose cannot trip the scan. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => line.replace(/[^\n]/g, ' '));
}

interface ImportRecord {
  readonly specifier: string;
  readonly names: readonly string[];
}

/** Every `import … from '…'` in a source file, with the names it binds. */
function readImports(source: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  const pattern = /import\s+(?:type\s+)?(?:\{([^}]*)\}|[\w*\s,]+?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of withoutComments(source).matchAll(pattern)) {
    const [, braced, specifier] = match;
    const names = (braced ?? '')
      .split(',')
      .map((entry) => entry.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter((entry) => entry.length > 0);
    records.push({ specifier, names });
  }
  return records;
}

/** The old-module import that makes a file half-ported, or null. */
function halfPortedImport(imports: readonly ImportRecord[]): { module: string; name: string } | null {
  const touchesNew = imports.some((entry) => entry.specifier.includes(NEW_MODULE_FRAGMENT));
  if (!touchesNew) return null;

  for (const entry of imports) {
    const module = OLD_MODULES.find((candidate) => entry.specifier.endsWith(candidate));
    if (!module) continue;
    const exempt = UNPORTED_SYMBOLS[module] ?? [];
    const offending = entry.names.find((name) => !exempt.includes(name));
    // A bare or default import of an old module names nothing to exempt, so it
    // counts on its own — it can only have been taken for a ported symbol.
    if (entry.names.length === 0 || offending) {
      return { module, name: offending ?? '(default or namespace import)' };
    }
  }
  return null;
}

/** Every `.ts` file under `src/`, tests excluded. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

/**
 * A vacuity floor, not a target. The scan walking the wrong directory, or a
 * broken traversal, would otherwise report zero violations and read as a pass.
 */
const MINIMUM_SCANNED_FILES = 200;

describe('no file holds half of the catalog port', () => {
  it('every source file reads from one side or the other', () => {
    const files = sourceFiles(SOURCE_DIR);
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_SCANNED_FILES);

    const violations = files.flatMap((file) => {
      const found = halfPortedImport(readImports(readFileSync(file, 'utf8')));
      if (!found) return [];
      return [
        `${relative(SOURCE_DIR, file)} imports ${found.name} from ${found.module} ` +
          `while also importing from ${NEW_MODULE_FRAGMENT} — port the rest of the file or none of it.`,
      ];
    });

    expect(violations).toEqual([]);
  });

  // ── The gate's own behaviour, against synthetic inputs ──────────────────
  //
  // `halfPortedImport` is pure so it can be exercised on the shapes that
  // distinguish it from a check that always passes. Without these, a scan that
  // silently matched nothing would look identical to a clean tree.

  it('flags a file that mixes the two sides', () => {
    const source = `
      import { playableTrackFilter } from '../utils/catalogVisibility';
      import { toTrackDto } from '../db/catalog/serialize';
    `;
    expect(halfPortedImport(readImports(source))).toEqual({
      module: 'utils/catalogVisibility',
      name: 'playableTrackFilter',
    });
  });

  it('flags a mixed file whose old import is type-only', () => {
    const source = `
      import type { CatalogPage } from '../utils/playableContainers';
      import { findAlbumsWithPlayableTracks } from '../db/catalog/containers';
    `;
    expect(halfPortedImport(readImports(source))?.name).toBe('CatalogPage');
  });

  it('flags a mixed file that imports the old module as a namespace', () => {
    const source = `
      import * as helpers from '../utils/musicHelpers';
      import { toAlbumDto } from '../db/catalog/serialize';
    `;
    expect(halfPortedImport(readImports(source))?.module).toBe('utils/musicHelpers');
  });

  it('allows a file still entirely on the old side', () => {
    const source = `import { playableTrackFilter } from '../utils/catalogVisibility';`;
    expect(halfPortedImport(readImports(source))).toBeNull();
  });

  it('allows a file entirely on the new side', () => {
    const source = `import { playableTrackFilter } from '../db/catalog/visibility';`;
    expect(halfPortedImport(readImports(source))).toBeNull();
  });

  it('allows the unported request helper alongside the new modules', () => {
    const source = `
      import { getRequestUserId } from '../utils/catalogVisibility';
      import { playableTrackFilter } from '../db/catalog/visibility';
    `;
    expect(halfPortedImport(readImports(source))).toBeNull();
  });

  it('does not exempt a ported symbol imported beside the unported one', () => {
    const source = `
      import { getRequestUserId, canViewPlaylist } from '../utils/catalogVisibility';
      import { playableTrackFilter } from '../db/catalog/visibility';
    `;
    expect(halfPortedImport(readImports(source))?.name).toBe('canViewPlaylist');
  });

  it('is not fooled by the offending shapes appearing in a comment', () => {
    const source = `
      // import { playableTrackFilter } from '../utils/catalogVisibility';
      import { toTrackDto } from '../db/catalog/serialize';
    `;
    expect(halfPortedImport(readImports(source))).toBeNull();
  });

  it('names every exemption by identity, so a superstring cannot absorb one', () => {
    const source = `
      import { getRequestUserIdAndMore } from '../utils/catalogVisibility';
      import { playableTrackFilter } from '../db/catalog/visibility';
    `;
    expect(halfPortedImport(readImports(source))?.name).toBe('getRequestUserIdAndMore');
  });
});

describe('the exemption list', () => {
  /**
   * `utils/catalogVisibility.ts` and its three siblings must be GONE by the end
   * of Task 10c — not deprecated, not re-exported. When they are, nothing can
   * import an unported symbol from them, so the list has to be empty. This
   * fails the moment the modules are deleted while an exemption survives, which
   * is the only way the exemption could quietly become permanent.
   */
  it('is empty once the Mongoose modules are gone', () => {
    const remaining = OLD_MODULES.filter((module) => {
      const path = join(SOURCE_DIR, `${module}.ts`);
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    });

    if (remaining.length === 0) {
      expect(Object.keys(UNPORTED_SYMBOLS)).toEqual([]);
      return;
    }

    // While they exist, every exemption must name a module that still exists
    // and a symbol that module actually exports — an exemption for a symbol
    // nobody exports is an exemption that has stopped protecting anything.
    for (const [module, symbols] of Object.entries(UNPORTED_SYMBOLS)) {
      expect(remaining).toContain(module as (typeof OLD_MODULES)[number]);
      const source = readFileSync(join(SOURCE_DIR, `${module}.ts`), 'utf8');
      for (const symbol of symbols) {
        expect(source).toContain(`export function ${symbol}`);
      }
    }
  });
});
