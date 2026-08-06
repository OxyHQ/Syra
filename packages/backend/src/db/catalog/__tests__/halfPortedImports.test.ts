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
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'bun:test';

const SOURCE_DIR = join(__dirname, '..', '..', '..');

/**
 * The Mongoose modules Task 10 replaces, by path relative to `src/`.
 *
 * Matched by RESOLVING each import specifier against the directory of the file
 * that writes it, never by comparing specifier text. The first version of this
 * gate used `specifier.endsWith('utils/catalogVisibility')`, which does not
 * match the sibling spelling `'./catalogVisibility'` — and the one file already
 * on both sides of the port, `utils/syraMedia.ts`, LIVES in `src/utils/`, so
 * that spelling is exactly the one it would use. Mutation-verified at the time:
 * adding such an import left all eleven tests green, and every synthetic fixture
 * used the `../utils/` spelling, so the fixture set could not see the
 * difference. Both spellings are exercised below now.
 */
const OLD_MODULES = [
  'utils/catalogVisibility',
  'utils/playableContainers',
  'utils/musicHelpers',
  'utils/catalogOwnership',
] as const;

/** Absolute path of each old module, without extension. */
const OLD_MODULE_PATHS = new Map(
  OLD_MODULES.map((module) => [resolve(SOURCE_DIR, module), module] as const)
);

/** The directory holding the drizzle replacements. */
const NEW_MODULE_DIR = resolve(SOURCE_DIR, 'db', 'catalog');

/**
 * Resolve one import specifier to an absolute path, or null for a package
 * import (`drizzle-orm`, `@oxyhq/db`) that can never be either side of this.
 *
 * The extension is stripped for EVERY spelling TypeScript accepts here, not
 * just `.ts`. Under `module: Node16` with `"type": "commonjs"`, TS resolves
 * `'./catalogVisibility.js'` to `catalogVisibility.ts` — and production runs the
 * compiled `dist`, where that specifier resolves for real. A `.ts`-only strip
 * left `'./catalogVisibility.js'` matching nothing and the gate green. Zero
 * occurrences in `src/` today, so this was latent rather than live, but a gate
 * with a known hole is what the last two rounds were spent closing.
 */
function resolveSpecifier(specifier: string, fromDir: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return resolve(fromDir, specifier).replace(/\.(?:[mc]?[jt]s)$/, '');
}

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

/**
 * The old-module import that makes a file half-ported, or null.
 *
 * `fromDir` is the directory of the file the imports were read from — required,
 * because a relative specifier means nothing without it. Passing it also makes
 * the modules under `db/catalog/` subject to the gate rather than exempt: their
 * own imports are `./`-relative, so a text match on `db/catalog/` never fired
 * for them and the whole directory was skipped by accident.
 */
function halfPortedImport(
  imports: readonly ImportRecord[],
  fromDir: string
): { module: string; name: string } | null {
  const resolved = imports.map((entry) => ({
    ...entry,
    path: resolveSpecifier(entry.specifier, fromDir),
  }));

  const touchesNew =
    fromDir === NEW_MODULE_DIR ||
    fromDir.startsWith(`${NEW_MODULE_DIR}${sep}`) ||
    resolved.some((entry) => entry.path?.startsWith(`${NEW_MODULE_DIR}${sep}`));
  if (!touchesNew) return null;

  for (const entry of resolved) {
    const module = entry.path === null ? undefined : OLD_MODULE_PATHS.get(entry.path);
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

/**
 * The files allowed to hold both sides, each with the task that ends it.
 *
 * The gate's own rule is "port the rest of the file or none of it", and that is
 * right whenever the choice is free. It is not free when a file's SERVICE moved
 * to drizzle in one task and the file itself is scheduled for another: leaving
 * the call site on the Mongo formatter is not a deferral, it is a live defect —
 * `formatTracksWithCoverArt(tracks: any[])` accepts a drizzle row and returns
 * `{"id":"", …}`, which is what four endpoints answered until
 * `__tests__/recommendationDtos.test.ts` was written. Between shipping a broken
 * endpoint and holding both sides for one task, holding both sides wins.
 *
 * Registered BY IDENTITY on the path relative to `src/`, never by substring —
 * this branch has shipped four containment bugs in matchers, one written inside
 * the check built against the previous two.
 *
 * Held to BOTH directions, exactly like `hybridServices.ts`:
 *
 *   1. A registered file may hold both sides. Nothing else may.
 *   2. A registered file MUST still hold both sides. When its port lands, the
 *      entry fails as stale and has to be deleted — so this registry shrinks to
 *      nothing as Task 10c-3 finishes, instead of quietly outliving its reason
 *      the way an exemption list does.
 */
const HALF_PORTED_BY_NECESSITY: Readonly<Record<string, { owner: string; reason: string }>> = {
  'controllers/browse.controller.ts': {
    owner: 'Task 10c-3',
    reason:
      'The personalised shelf reads `recommendationService`, which is drizzle, so it serializes ' +
      'through `db/catalog/hydrate`. Every other read in the handler — the container helpers, ' +
      '`TrackModel.find` — is still Mongo and moves with the rest of the controller.',
  },
};

const REGISTERED_HALF_PORTED = new Set(Object.keys(HALF_PORTED_BY_NECESSITY));

describe('no file holds half of the catalog port', () => {
  // Named for what it walks. The scan covers `src/` only, so package-root files
  // (`server.ts`) are outside it — immaterial today, since `server.ts` imports
  // `db/postgres` and never `db/catalog`, but the earlier name promised every
  // source file in the package and delivered every file under `src/`.
  it('every file under src/ reads from one side or the other', () => {
    const files = sourceFiles(SOURCE_DIR);
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_SCANNED_FILES);

    const violations = files.flatMap((file) => {
      const name = relative(SOURCE_DIR, file);
      const found = halfPortedImport(readImports(readFileSync(file, 'utf8')), dirname(file));
      if (!found) return [];
      // Compared by identity through a Set of the registry's own keys — `name`
      // is already the exact relative path the registry is written in. A `Set`
      // rather than `in` or `includes`: `in` also answers true for inherited
      // keys (`toString`), and `includes` on a joined string would be the
      // containment match this branch has now shipped four times.
      if (REGISTERED_HALF_PORTED.has(name)) return [];
      return [
        `${name} imports ${found.name} from ${found.module} ` +
          `while also reading through db/catalog — port the rest of the file or none of it.`,
      ];
    });

    expect(violations).toEqual([]);
  });

  /**
   * The stale direction. A registered file that no longer holds both sides has
   * been ported, and its entry is now a licence with nothing to license.
   */
  it('every registered exception still holds both sides', () => {
    const stale = Object.entries(HALF_PORTED_BY_NECESSITY).flatMap(([name, entry]) => {
      const file = resolve(SOURCE_DIR, name);
      const found = halfPortedImport(readImports(readFileSync(file, 'utf8')), dirname(file));
      if (found) return [];
      return [
        `${name} no longer holds both sides — ${entry.owner} has landed. ` +
          `Delete its entry from HALF_PORTED_BY_NECESSITY.`,
      ];
    });

    expect(stale).toEqual([]);
  });

  // ── The gate's own behaviour, against synthetic inputs ──────────────────
  //
  // `halfPortedImport` is pure so it can be exercised on the shapes that
  // distinguish it from a check that always passes. Without these, a scan that
  // silently matched nothing would look identical to a clean tree.
  //
  // EVERY case is run from BOTH directories a real importer can sit in: a
  // controller reaching `../utils/…`, and a file inside `src/utils/` reaching
  // its sibling as `./…`. The first version of this gate handled only the first
  // spelling, and every fixture used it, so the fixture set sat entirely on one
  // side of the distinction the gate exists to make.

  const FROM_CONTROLLER = join(SOURCE_DIR, 'controllers');
  const FROM_UTILS = join(SOURCE_DIR, 'utils');
  const FROM_DB_CATALOG = join(SOURCE_DIR, 'db', 'catalog');

  /** The same case in both spellings: `../utils/x` from elsewhere, `./x` from within. */
  function bothSpellings(
    build: (oldModule: string, newModule: string) => string
  ): { source: string; fromDir: string }[] {
    return [
      { source: build('../utils/catalogVisibility', '../db/catalog/visibility'), fromDir: FROM_CONTROLLER },
      { source: build('./catalogVisibility', '../db/catalog/visibility'), fromDir: FROM_UTILS },
    ];
  }

  it('flags a file that mixes the two sides, in either spelling', () => {
    for (const { source, fromDir } of bothSpellings(
      (oldModule, newModule) => `
        import { playableTrackFilter } from '${oldModule}';
        import { toTrackDto } from '${newModule}';
      `
    )) {
      expect(`${fromDir}: ${JSON.stringify(halfPortedImport(readImports(source), fromDir))}`).toBe(
        `${fromDir}: ${JSON.stringify({ module: 'utils/catalogVisibility', name: 'playableTrackFilter' })}`
      );
    }
  });

  it('flags the sibling spelling from inside src/utils — the syraMedia.ts shape', () => {
    // `utils/syraMedia.ts` is the one file already reading through db/catalog
    // AND living in `src/utils/`, so `'./catalogVisibility'` is the spelling a
    // regression would actually take. This case is the reason the gate resolves
    // paths instead of matching specifier text.
    const source = `
      import { playableTrackFilter } from '../db/catalog/visibility';
      import { isPlayableTrack } from './catalogVisibility';
    `;
    expect(halfPortedImport(readImports(source), FROM_UTILS)?.name).toBe('isPlayableTrack');
  });

  it('flags a file INSIDE db/catalog that reaches back to an old module', () => {
    // These files import each other as `./visibility`, so nothing in their own
    // specifier text says `db/catalog` — the whole directory was exempt by
    // accident until membership was decided by the importing file's location.
    const source = `import { isPlayableTrack } from '../../utils/catalogVisibility';`;
    expect(halfPortedImport(readImports(source), FROM_DB_CATALOG)?.module).toBe(
      'utils/catalogVisibility'
    );
  });

  it('flags a mixed file whose old import is type-only', () => {
    const source = `
      import type { CatalogPage } from '../utils/playableContainers';
      import { findAlbumsWithPlayableTracks } from '../db/catalog/containers';
    `;
    expect(halfPortedImport(readImports(source), FROM_CONTROLLER)?.name).toBe('CatalogPage');
  });

  it('flags a mixed file that imports the old module as a namespace', () => {
    const source = `
      import * as helpers from '../utils/musicHelpers';
      import { toAlbumDto } from '../db/catalog/serialize';
    `;
    expect(halfPortedImport(readImports(source), FROM_CONTROLLER)?.module).toBe(
      'utils/musicHelpers'
    );
  });

  it('allows a file still entirely on the old side, in either spelling', () => {
    for (const { source, fromDir } of bothSpellings(
      (oldModule) => `import { playableTrackFilter } from '${oldModule}';`
    )) {
      expect(`${fromDir}: ${halfPortedImport(readImports(source), fromDir)}`).toBe(`${fromDir}: null`);
    }
  });

  it('allows a file entirely on the new side', () => {
    const source = `import { playableTrackFilter } from '../db/catalog/visibility';`;
    expect(halfPortedImport(readImports(source), FROM_CONTROLLER)).toBeNull();
  });

  it('allows db/catalog modules importing each other', () => {
    const source = `
      import { playableTrackFilter } from './visibility';
      import { PROTECTED_COLUMNS_BY_TABLE } from '../schema/protectedColumns';
      import { and, eq } from 'drizzle-orm';
    `;
    expect(halfPortedImport(readImports(source), FROM_DB_CATALOG)).toBeNull();
  });

  it('allows the unported request helper alongside the new modules, in either spelling', () => {
    for (const { source, fromDir } of bothSpellings(
      (oldModule, newModule) => `
        import { getRequestUserId } from '${oldModule}';
        import { playableTrackFilter } from '${newModule}';
      `
    )) {
      expect(`${fromDir}: ${halfPortedImport(readImports(source), fromDir)}`).toBe(`${fromDir}: null`);
    }
  });

  it('does not exempt a ported symbol imported beside the unported one', () => {
    const source = `
      import { getRequestUserId, canViewPlaylist } from '../utils/catalogVisibility';
      import { playableTrackFilter } from '../db/catalog/visibility';
    `;
    expect(halfPortedImport(readImports(source), FROM_CONTROLLER)?.name).toBe('canViewPlaylist');
  });

  it('is not fooled by the offending shapes appearing in a comment', () => {
    const source = `
      // import { playableTrackFilter } from '../utils/catalogVisibility';
      import { toTrackDto } from '../db/catalog/serialize';
    `;
    expect(halfPortedImport(readImports(source), FROM_CONTROLLER)).toBeNull();
  });

  it('names every exemption by identity, so a superstring cannot absorb one', () => {
    const source = `
      import { getRequestUserIdAndMore } from '../utils/catalogVisibility';
      import { playableTrackFilter } from '../db/catalog/visibility';
    `;
    expect(halfPortedImport(readImports(source), FROM_CONTROLLER)?.name).toBe(
      'getRequestUserIdAndMore'
    );
  });

  it('flags an explicit-extension specifier, in every spelling TS accepts', () => {
    // `'./catalogVisibility.js'` is legal under `module: Node16` — TS resolves it
    // to the `.ts` source, and the compiled `dist` this ships as resolves it
    // literally. A `.ts`-only strip let this one through with the gate green.
    for (const extension of ['.js', '.ts', '.mjs', '.cjs', '.mts', '.cts']) {
      const source = `
        import { isPlayableTrack } from './catalogVisibility${extension}';
        import { playableTrackFilter } from '../db/catalog/visibility';
      `;
      expect(`${extension}: ${halfPortedImport(readImports(source), FROM_UTILS)?.name}`).toBe(
        `${extension}: isPlayableTrack`
      );
    }
  });

  it('ignores a package import that merely looks like a path', () => {
    const source = `
      import { something } from '@scope/utils/catalogVisibility';
      import { toTrackDto } from '../db/catalog/serialize';
    `;
    expect(halfPortedImport(readImports(source), FROM_CONTROLLER)).toBeNull();
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
