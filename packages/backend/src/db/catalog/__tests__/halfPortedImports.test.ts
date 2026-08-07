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
 * `getRequestUserId` WAS the one exception, listed by identity rather than by
 * pattern: it reads an id off an Express request and has nothing to do with
 * either database, so a controller that had moved its queries but still called
 * it was not half-ported. Task 10c-3 gave it a home of its own —
 * `utils/requestUser.ts` — so {@link UNPORTED_SYMBOLS} is now EMPTY, and it did
 * not wait for `utils/catalogVisibility.ts` to be deleted: that module survives
 * for `playlists.controller` (Task 11) and `search.controller`, and an exemption
 * that outlives the work it describes is what these registries exist to prevent.
 *
 * The exemption MECHANISM stays, because emptying the list must not silently
 * retire the tests that prove it matches by identity. {@link halfPortedImport}
 * therefore takes the map as a parameter, and the behavioural cases below pass a
 * synthetic one.
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
 * match the sibling spelling `'./catalogVisibility'` — and the file that was on
 * both sides of the port when this was written, `utils/syraMedia.ts`, LIVES in
 * `src/utils/`, so that spelling is exactly the one it would use. (Task 14
 * finished that file; it still reads `db/catalog` from `src/utils/`, which is
 * what keeps it the right example for the SPELLING even though it is no longer
 * half-ported.) Mutation-verified at the time:
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

/** Symbols an old module exports that have NO drizzle counterpart. */
type ExemptSymbols = Readonly<Record<string, readonly string[]>>;

/**
 * Importing one of these alongside the new modules is not a half-port. Keyed by
 * module path relative to `src/`.
 *
 * EMPTY since Task 10c-3 — see this file's doc comment and the final test below.
 */
const UNPORTED_SYMBOLS: ExemptSymbols = {};

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
  fromDir: string,
  exemptions: ExemptSymbols = UNPORTED_SYMBOLS
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
    const exempt = exemptions[module] ?? [];
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
  // `controllers/browse.controller.ts` was the only entry, registered by 10c-1
  // when its personalised shelf moved to drizzle ahead of the rest of the
  // handler. 10c-3 ported the rest, so the entry failed as stale — the shrink
  // direction firing on real work — and is deleted rather than edited.
};

const REGISTERED_HALF_PORTED = new Set(Object.keys(HALF_PORTED_BY_NECESSITY));

/**
 * The Mongoose modules Task 10 replaces that are STILL HERE, each with the task
 * that deletes it and the exact set of files still importing it.
 *
 * `utils/playableContainers.ts` was Task 10c's stated finish line and did not
 * make it, for exactly one reason, named here rather than left in a report: the
 * only file still importing it is `search.controller.ts`, whose port is blocked
 * on a product ruling about text-search semantics (`ilike '%q%'` is faithful and
 * unindexed; `websearch_to_tsquery` over the existing GIN-indexed
 * `search_vector` is indexed and changes what matches). The moment that ruling
 * lands, this entry goes with it.
 *
 * Held to THREE directions, so it cannot rot in any of them:
 *
 *   1. A module listed here must still EXIST. Deleting the file without deleting
 *      the entry fails.
 *   2. A module listed here must still have importers — the exact set recorded.
 *      An importer that ports fails the gate as stale; a NEW importer of a dying
 *      module fails it as a regression, which is the direction prose can never
 *      catch.
 *   3. A Task 10 module NOT listed here must be GONE. `utils/catalogOwnership.ts`
 *      is the first to satisfy that, deleted in 10c-3 once `albums.controller`
 *      and `tracks.controller` — its only two importers — moved to
 *      `db/catalog/ownership.ts`.
 */
const SURVIVING_MONGOOSE_MODULES: Readonly<
  Record<string, { owner: string; importers: readonly string[]; reason: string }>
> = {
  // `utils/playableContainers` is GONE — Task 10c's stated finish line, reached
  // once the text-search ruling unblocked `search.controller`, its last
  // importer. Its entry is deleted rather than kept, and the third test below
  // is what would fail if the file came back.
  // EMPTY, and that is the finish line rather than an oversight: Task 11 ported
  // `playlists.controller`, the last importer of both survivors, so
  // `utils/musicHelpers.ts` and `utils/catalogVisibility.ts` are deleted along
  // with `utils/imageFirstSort.ts`, whose only importer was the same file. The
  // deletion gate below is what now holds all four of `OLD_MODULES` down: an
  // unregistered Task 10 module that comes back fails it.
};

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
   *
   * `HALF_PORTED_BY_NECESSITY` is EMPTY today — `browse.controller`'s entry
   * failed here and was deleted, which is the mechanism working — so the loop
   * below iterates nothing and this test on its own asserts nothing. The
   * registry-empty assertion is what keeps it honest: it fails the moment
   * somebody adds an entry without checking that it really holds both sides,
   * and it fails LOUDLY rather than by silently passing over zero entries.
   *
   * The same vacuity was deleted outright for `UNPORTED_SYMBOLS` below, and the
   * treatments differ on purpose: nothing is expected to re-enter that list,
   * while a future task splitting a file across the two sides genuinely needs
   * this one, so the loop is kept and its emptiness is asserted instead.
   */
  it('every registered exception still holds both sides, and there are none', () => {
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
    // Delete this line when an entry is legitimately added; the loop above is
    // then doing the work and this assertion has stopped describing the tree.
    expect(Object.keys(HALF_PORTED_BY_NECESSITY)).toEqual([]);
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

  /**
   * The three cases below exercise the EXEMPTION mechanism, which no longer has
   * a real entry to exercise it: `getRequestUserId` moved to
   * `utils/requestUser.ts` in Task 10c-3 and {@link UNPORTED_SYMBOLS} is empty.
   *
   * They pass a synthetic map rather than being deleted with the last entry. An
   * empty list would otherwise silently retire the proof that exemptions match
   * by IDENTITY — the property whose absence let a 74-byte superstring through
   * an `includes()` check elsewhere on this branch — and the next person to add
   * an exemption would inherit an untested matcher.
   */
  const SYNTHETIC_EXEMPTIONS = { 'utils/catalogVisibility': ['getRequestUserId'] } as const;

  it('allows an exempt symbol alongside the new modules, in either spelling', () => {
    for (const { source, fromDir } of bothSpellings(
      (oldModule, newModule) => `
        import { getRequestUserId } from '${oldModule}';
        import { playableTrackFilter } from '${newModule}';
      `
    )) {
      expect(
        `${fromDir}: ${halfPortedImport(readImports(source), fromDir, SYNTHETIC_EXEMPTIONS)}`
      ).toBe(`${fromDir}: null`);
    }
  });

  it('does not exempt a ported symbol imported beside the exempt one', () => {
    const source = `
      import { getRequestUserId, canViewPlaylist } from '../utils/catalogVisibility';
      import { playableTrackFilter } from '../db/catalog/visibility';
    `;
    expect(
      halfPortedImport(readImports(source), FROM_CONTROLLER, SYNTHETIC_EXEMPTIONS)?.name
    ).toBe('canViewPlaylist');
  });

  /**
   * With the real list empty, an exempt-looking import is NOT exempt — which is
   * the live behaviour now and the thing that would break if somebody re-added
   * `getRequestUserId` to an old module.
   */
  it('exempts nothing under the real, empty list', () => {
    const source = `
      import { getRequestUserId } from '../utils/catalogVisibility';
      import { playableTrackFilter } from '../db/catalog/visibility';
    `;
    expect(halfPortedImport(readImports(source), FROM_CONTROLLER)?.name).toBe('getRequestUserId');
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
    expect(
      halfPortedImport(readImports(source), FROM_CONTROLLER, SYNTHETIC_EXEMPTIONS)?.name
    ).toBe('getRequestUserIdAndMore');
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

describe('the Mongoose modules still standing', () => {
  /** Does `module` still exist on disk? */
  function moduleExists(module: string): boolean {
    try {
      readFileSync(join(SOURCE_DIR, `${module}.ts`));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Every file under `src/` (tests excluded) that really imports `module`,
   * matched by RESOLVED PATH rather than by specifier text — the same rule the
   * detector above is written under, and for the same reason: `'./musicHelpers'`
   * and `'../utils/musicHelpers'` are the same module and a text match sees one
   * of them.
   *
   * Tests are out of scope on purpose. A dying module's own unit test dies with
   * it, and this file's synthetic fixtures are template literals containing the
   * exact import lines it is looking for — scanning tests would count the gate
   * itself as an importer of every module it guards.
   */
  function importersOf(module: string): string[] {
    const target = resolve(SOURCE_DIR, module);
    return sourceFiles(SOURCE_DIR)
      .filter((file) =>
        readImports(readFileSync(file, 'utf8')).some(
          (entry) => resolveSpecifier(entry.specifier, dirname(file)) === target
        )
      )
      .map((file) => relative(SOURCE_DIR, file))
      .sort();
  }

  it('every registered survivor still exists', () => {
    const vanished = Object.keys(SURVIVING_MONGOOSE_MODULES).filter(
      (module) => !moduleExists(module)
    );
    expect(vanished).toEqual([]);
  });

  /**
   * The exact importer set, in both directions at once. An importer that ports
   * shrinks the real set and fails; a new importer of a dying module grows it
   * and fails. The second direction is the one nothing else on this branch
   * catches — `tsc` is happy either way.
   *
   * The registry is empty today, so this loop runs zero times. It is kept
   * rather than deleted BECAUSE it is the check a future entry needs, and
   * unlike the two assertions Task 11 removed alongside it, an empty loop here
   * is not a check that has stopped being able to fail — it is a check with
   * nothing registered to check. The vacuity floor below is what makes that
   * distinction hold.
   */
  it('every registered survivor is imported by exactly the files recorded', () => {
    for (const [module, entry] of Object.entries(SURVIVING_MONGOOSE_MODULES)) {
      expect(`${module}: ${importersOf(module).join(', ')}`).toBe(
        `${module}: ${[...entry.importers].sort().join(', ')}`
      );
    }
  });

  /**
   * The deletion gate. A Task 10 module absent from the registry must be gone —
   * so a module cannot be quietly kept alive by removing its entry, and the
   * finish line is a red test rather than a paragraph in a report.
   */
  it('every unregistered Task 10 module has been deleted', () => {
    // A `Set` rather than `in`, for this file's own reason: `in` also answers
    // true for inherited keys, so a module literally named `toString` would
    // register itself.
    const registered = new Set(Object.keys(SURVIVING_MONGOOSE_MODULES));
    const shouldBeGone = OLD_MODULES.filter(
      (module) => !registered.has(module) && moduleExists(module)
    );
    expect(shouldBeGone).toEqual([]);
  });

  /**
   * A vacuity floor for {@link importersOf}.
   *
   * It used to point at `utils/catalogVisibility`, which no longer exists — and
   * a floor asserting that a DELETED module still has importers is a floor that
   * can only fail. It points at a module that does exist instead, so it goes on
   * proving the traversal actually resolves specifiers to files. Without it, a
   * broken `importersOf` would report zero importers for every entry and make
   * the exact-set assertion above pass for a registry full of live modules.
   *
   * `db/catalog/visibility` rather than one of `OLD_MODULES`: all four of those
   * are gone now, which is the point of the deletion gate above, so nothing on
   * that list can carry this floor any more.
   */
  it('the importer scan finds something', () => {
    expect(importersOf('db/catalog/visibility').length).toBeGreaterThan(0);
  });
});

describe('the exemption list', () => {
  /**
   * It is empty TODAY, and the empty case is now the one that runs: Task 10c-3
   * moved `getRequestUserId` to `utils/requestUser.ts` rather than waiting for
   * `utils/catalogVisibility.ts` to be deleted, so the exemption stopped
   * outliving its reason before the module did.
   *
   * The non-empty branch is kept rather than deleted with the last entry,
   * because it is what holds a FUTURE exemption honest — it must name a module
   * that still exists and a symbol that module actually exports. Note this is a
   * weaker check than {@link SURVIVING_MONGOOSE_MODULES}'s: an exemption is
   * about a symbol, a survivor about a whole module, and only the second is a
   * deletion gate.
   */
  /**
   * The conditional half of this test — "while the old modules exist, every
   * exemption must name a module that still exists and a symbol it really
   * exports" — is DELETED rather than kept for a future entry.
   *
   * With the list empty it iterated over nothing, so the test asserted nothing
   * and passed: the branch carrying the real assertion was gated on every old
   * module already being gone, and they are not. A loop over an empty map is a
   * line that can never fire — the same class as a `delete` on a serializer that
   * never names the field. Re-adding an exemption means re-adding its check.
   *
   * What remains covered either way: the identity matching that makes an
   * exemption safe, exercised against a synthetic map in the first describe.
   */
  it('is empty', () => {
    expect(Object.keys(UNPORTED_SYMBOLS)).toEqual([]);
  });
});
