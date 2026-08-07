/**
 * The gate behind `hybridServices.ts` — the registry of catalog services that
 * may still import another vertical's Mongoose models.
 *
 * Task 10b's stated completion check, "a file is ported when its model import is
 * gone", does not survive the vertical split: ten catalog services also read
 * models Tasks 11, 13 and 15 own. This holds the registry to the two properties
 * that make the split safe to leave behind, and — more importantly — makes it
 * SHRINK rather than rot:
 *
 *   1. no registered file imports a CATALOG model;
 *   2. a registered file imports exactly its registered models — an
 *      unregistered MODEL fails as an oversight, a registered one that is gone
 *      fails as STALE;
 *   3. **every hybrid FILE in the tree is registered somewhere.**
 *
 * Property 3 was missing until the 10c review, and its absence is worth stating
 * plainly rather than quietly fixing: properties 1 and 2 both ITERATE the
 * registry, and `HYBRID_MODULES.length === 16` is a count floor, not discovery.
 * So the registry was a hand-maintained list checked only against itself, and
 * the one direction it could not fail in — a file that becomes hybrid and is
 * never added — is precisely the direction the gate exists for. A sweep found
 * three: `library.controller.ts` (made hybrid by Task 10c-3 itself),
 * `uploads.controller.ts` and `utils/syraMedia.ts`.
 *
 * Property 2's second direction is the whole point. An exemption list that only
 * checks "everything here is allowed" is satisfied forever by an entry nobody
 * needs any more, which is how `LAST_GENESIS_MIGRATION_TAG` sat three
 * migrations behind and how the identifier exemption outlived its offender.
 * It fired for real in Task 11: porting the library vertical left `Library`
 * registered against four files that no longer imported it, and every one of
 * them failed as stale rather than passing quietly.
 *
 * ## Matching is BY IDENTITY, and the fixtures prove it
 *
 * Two gates on this branch shipped with a loose match: the identifier exemption
 * used `includes()` and silently absorbed a 74-byte superstring of an exempt
 * name; `halfPortedImports.test.ts` used `endsWith()` and missed a whole
 * specifier spelling. Both were caught only after the fact.
 *
 * So every comparison here is an exact-equality Set lookup, and the fixtures put
 * a SUPERSTRING (`TrackFingerprint` against `Track`) and a SUBSTRING
 * (`Track` against `TrackFingerprint`) on the wrong side of each match, plus a
 * name that merely CONTAINS a registered model (`UserUploadArchive` against
 * `UserUpload`). Without those, a `includes()`-based rewrite of this file passes
 * every other assertion in it.
 *
 * ## Vacuity floor
 *
 * A parser that returns nothing satisfies every "no catalog import" assertion.
 * The floor asserts the walk found imports at all, and that it found them in a
 * file known to have them.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  CATALOG_MODELS,
  LIVE_TASK_IDS,
  HYBRID_MODULES,
  NON_CATALOG_MODEL_OWNERS,
  OWNING_TASKS,
  UNPORTED_CATALOG_MODULES,
  type CatalogModel,
  type NonCatalogModel,
} from '../hybridServices';

// `__dirname`, not `import.meta.dir`: this package builds to CommonJS.
const SRC = join(__dirname, '..', '..', '..');

/**
 * Model names imported from `models/<Name>` by one file.
 *
 * Matches the SPECIFIER, not the imported bindings: `import { ArtistModel } from
 * '../../models/CatalogEntity'` is an import of `CatalogEntity`, and a registry
 * keyed on binding names would have to know that `ArtistModel` and `PersonModel`
 * are both that file. The path is the identity Mongoose organises by.
 *
 * A TYPE-ONLY import counts. `manifestService.ts` imports only `type ITrack` and
 * is unported for exactly that reason — its adapters read a column that no
 * longer exists — so a parser that skipped type imports would call the one file
 * whose type import IS the problem clean.
 */
function modelImportsIn(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/from\s+'(?:\.\.?\/)+models\/([A-Za-z0-9_]+)'/g)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return [...found].sort();
}

function modelImportsOf(relativePath: string): string[] {
  return modelImportsIn(readFileSync(join(SRC, relativePath), 'utf8'));
}

const CATALOG_MODEL_SET = new Set<string>(CATALOG_MODELS);
const KNOWN_NON_CATALOG = new Set<string>(Object.keys(NON_CATALOG_MODEL_OWNERS));

/** Exact-equality membership. Never `includes`, never `endsWith`. */
function isCatalogModel(name: string): boolean {
  return CATALOG_MODEL_SET.has(name);
}

/**
 * A file is HYBRID when it imports a Mongoose model AND reads Postgres — the
 * two-store shape the registry exists to record.
 *
 * "Reads Postgres" is any relative import resolving under `src/db/`, not
 * `db/catalog/` alone: `services/compliance/takedown.ts` and
 * `services/recommendations/recordPlay.ts` reach `db/postgres` and `db/schema/`
 * directly and are just as hybrid. Narrowing it to `db/catalog/` misses both.
 *
 * The converse is deliberately NOT required. `services/recommendations/taste.ts`
 * is registered and imports only `CatalogRelationModel` with no Postgres import
 * at all — it is residue rather than a split file, and property 2 already fails
 * if its entry goes stale. Requiring every registered file to appear in this
 * sweep would delete a true entry.
 */
const DB_DIR = resolve(SRC, 'db');

/** Blank out comments, preserving line structure, so prose cannot trip the scan. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => line.replace(/[^\n]/g, ' '));
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
 * Does this file read Postgres? Matched by RESOLVED PATH, never by specifier
 * text — `utils/syraMedia.ts` reaches its neighbours as `./x` and a file inside
 * `src/db/` reaches them as `./y`, so a text match on `db/` sees neither.
 */
function readsPostgres(source: string, fromDir: string): boolean {
  if (fromDir === DB_DIR || fromDir.startsWith(`${DB_DIR}${sep}`)) return true;
  return [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].some((match) =>
    resolve(fromDir, match[1]).replace(/\.(?:[mc]?[jt]s)$/, '').startsWith(`${DB_DIR}${sep}`)
  );
}

/** Every file under `src/` that holds a Mongoose model AND a Postgres read. */
function sweepHybridFiles(): string[] {
  return sourceFiles(SRC)
    .filter((file) => {
      const source = withoutComments(readFileSync(file, 'utf8'));
      return modelImportsIn(source).length > 0 && readsPostgres(source, dirname(file));
    })
    .map((file) => relative(SRC, file))
    .sort();
}

/**
 * A vacuity floor for the sweep itself. A traversal that found nothing, or a
 * `readsPostgres` that answered false for everything, would report zero
 * unregistered files and read exactly like a clean tree.
 */
const MINIMUM_HYBRID_FILES = 15;

/**
 * The same floor for property 4's sweep. **Six** today, down from ten in Task
 * 11, and the drop is the gate doing its job rather than being weakened:
 * `podcastAudio.controller` (`TrackKey`), `podcasts.controller`
 * (`CatalogEntity`), `services/podcasts/resolvePersons.ts` (`CatalogEntity`) and
 * `scripts/reseedPersons.ts` (`CatalogEntity`) all stopped importing a catalog
 * model when Task 12 ported them.
 *
 * Three, down from six: Task 19a ported the three bulk loaders whose target
 * tables already had live readers (`backfillTrackFingerprints`,
 * `importIsrcRegistry`, `importMusicBrainzArtists`).
 *
 * What is left is `uploads.controller.ts` (six catalog models, Task 13) and the
 * two bulk-load scripts that are genuinely dormant — `importDiscogsReleases`
 * and `seedMusicData`, both filling tables nothing reads, both Task 19's. The
 * three-population split Task 11 recorded here has collapsed with the drop — the
 * two survivors bar `uploads.controller` are entirely Mongoose — so it is not
 * restated.
 *
 * It drops further as those files port, and a sweep that suddenly finds none is
 * a broken walk, not a finished migration.
 */
const MINIMUM_CATALOG_MODEL_IMPORTERS = 3;

describe('property 3 — every hybrid file in the tree is registered', () => {
  const REGISTERED = new Set([
    ...HYBRID_MODULES.map((entry) => entry.file),
    ...UNPORTED_CATALOG_MODULES.map((entry) => entry.file),
  ]);

  it('the sweep finds the hybrid files that are known to exist', () => {
    const found = sweepHybridFiles();
    expect(found.length).toBeGreaterThanOrEqual(MINIMUM_HYBRID_FILES);
    // Named, so a broken `readsPostgres` reports which shape it lost rather
    // than a bare count. `takedown.ts` reads `db/postgres` with no
    // `db/catalog/` import at all; `syraMedia.ts` sits in `src/utils/` and
    // reaches its neighbours as `./x`.
    expect(found).toContain('services/compliance/takedown.ts');
    expect(found).toContain('utils/syraMedia.ts');
  });

  it('registers every one of them, in one registry or the other', () => {
    // Compared by identity through a Set of the registries' own keys — `name`
    // is already the exact relative path they are written in.
    const unregistered = sweepHybridFiles().filter((file) => !REGISTERED.has(file));
    expect(unregistered).toEqual([]);
  });
});

/**
 * The blind spot properties 1-3 share, and what closes it.
 *
 * Property 3 finds a file holding a Mongoose model AND a Postgres read, and
 * `halfPortedImports.test.ts` finds a file importing a dying module AND
 * `db/catalog`. Both require the file to be on BOTH sides. A file that is
 * entirely Mongoose while reading a table that has already MOVED satisfies
 * neither, so nothing looked at it — and such a file is not merely unported, it
 * is broken: a `find()` against a collection the application stopped writing
 * returns nothing, with no error anywhere and `tsc` perfectly happy.
 *
 * Task 11 measured it: nine files were in that state, including the two
 * `moderation/` ones whose TRACK and ARTIST reads had been dead since Task 10.
 * They were found by writing this sweep, not by reading the code, which is the
 * whole argument for having it.
 *
 * The finish line this draws is the real one — not "no file holds both sides"
 * but "no file imports a catalog model at all". {@link UNPORTED_CATALOG_MODULES}
 * shrinks to nothing when that happens, and the "still imports what it is
 * listed for" assertion below makes each entry fail the moment its file ports.
 */
describe('property 4 — every catalog-model importer in the tree is registered', () => {
  /** Every file under `src/` importing a model `schema/catalog.ts` owns. */
  function sweepCatalogModelImporters(): string[] {
    return sourceFiles(SRC)
      .filter((file) => modelImportsIn(withoutComments(readFileSync(file, 'utf8'))).some(isCatalogModel))
      .map((file) => relative(SRC, file))
      .sort();
  }

  it('the sweep finds the catalog-model importers that are known to exist', () => {
    const found = sweepCatalogModelImporters();
    // A floor AND two names, so a broken traversal says which shape it lost
    // rather than reporting a clean tree. `uploads.controller` holds six
    // catalog models; `seedMusicData` is a script, i.e. outside every directory
    // the other sweeps in this file happen to walk.
    expect(found.length).toBeGreaterThanOrEqual(MINIMUM_CATALOG_MODEL_IMPORTERS);
    expect(found).toContain('controllers/uploads.controller.ts');
    expect(found).toContain('scripts/seedMusicData.ts');
  });

  it('registers every one of them as unported', () => {
    // NOT `REGISTERED`: property 1 already forbids a HYBRID_MODULES entry from
    // importing a catalog model, so the only registry that can license one is
    // the unported list. Checking against both would let a file satisfy this
    // sweep from an entry property 1 is simultaneously failing.
    const unported = new Set(UNPORTED_CATALOG_MODULES.map((entry) => entry.file));
    const unregistered = sweepCatalogModelImporters().filter((file) => !unported.has(file));
    expect(unregistered).toEqual([]);
  });
});

describe('the registry is well formed', () => {
  it('registers every hybrid file exactly once', () => {
    const files = HYBRID_MODULES.map((entry) => entry.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it('registers only models with a known owning task', () => {
    for (const entry of HYBRID_MODULES) {
      for (const model of entry.models) {
        expect(`${entry.file} -> ${model}`).toBe(
          KNOWN_NON_CATALOG.has(model) ? `${entry.file} -> ${model}` : `${entry.file} -> UNKNOWN`
        );
      }
    }
  });

  it('maps every registrable model to a real task', () => {
    for (const [model, task] of Object.entries(NON_CATALOG_MODEL_OWNERS)) {
      expect(`${model}: ${OWNING_TASKS[task] ?? 'NO SUCH TASK'}`).toContain('Task ');
    }
  });

  it('never registers a catalog model as permissible', () => {
    // The registry is a licence to read ANOTHER vertical, never this one's.
    for (const model of Object.keys(NON_CATALOG_MODEL_OWNERS)) {
      expect(`${model} is catalog: ${isCatalogModel(model)}`).toBe(`${model} is catalog: false`);
    }
  });
});

describe('property 1 — no registered file imports a catalog model', () => {
  for (const entry of HYBRID_MODULES) {
    it(`${entry.file} is off the catalog models`, () => {
      const offending = modelImportsOf(entry.file).filter(isCatalogModel);
      // Named in the message so a failure says WHICH model, not "expected [] to equal [X]".
      expect(`${entry.file}: ${offending.join(', ') || 'none'}`).toBe(`${entry.file}: none`);
    });
  }
});

describe('property 2 — a registered file imports exactly its registered models', () => {
  for (const entry of HYBRID_MODULES) {
    it(`${entry.file} matches its registry entry`, () => {
      const actual = modelImportsOf(entry.file);
      const registered = [...entry.models].sort();

      const unregistered = actual.filter((name) => !(entry.models as readonly string[]).includes(name));
      const stale = registered.filter((name) => !actual.includes(name));

      // Both directions in ONE assertion so a failure shows the whole delta:
      // an unregistered import is an oversight, a stale entry means the owning
      // task landed and the registry was not shrunk.
      expect(
        `${entry.file} | unregistered: ${unregistered.join(', ') || 'none'}` +
        ` | stale: ${stale.join(', ') || 'none'}`
      ).toBe(`${entry.file} | unregistered: none | stale: none`);
    });
  }
});

describe('the unported list cannot outlive its work', () => {
  for (const entry of UNPORTED_CATALOG_MODULES) {
    it(`${entry.file} still imports what it is listed for`, () => {
      const actual = new Set(modelImportsOf(entry.file));
      const missing = entry.models.filter((model) => !actual.has(model));
      // A file listed as unported that no longer imports the model IS ported,
      // and the entry is stale — the same failure direction property 2 has.
      expect(`${entry.file} no longer imports: ${missing.join(', ') || 'none'}`).toBe(
        `${entry.file} no longer imports: none`
      );
    });
  }

  /**
   * IDENTITY against the live set, not `toContain('Task ')`.
   *
   * The old check passed for `Task 10` — a CLOSED task — and equally for
   * `Task 999`, and five entries named a finished task for three tasks running
   * underneath it. That is the fifth instance of substring-where-identity-was-
   * meant on this branch, and the first one sitting on the check that would
   * have caught the others.
   *
   * What makes this DISCOVER rather than merely assert: an owner leaves
   * `LIVE_TASK_IDS` when its task closes, because closing a task already means
   * deleting its `OWNING_TASKS` / `CROSS_CUTTING_TASKS` entry (the convention
   * `library` and `podcasts` already follow). Every registry entry still naming
   * it goes red on the next run, with no separate audit to remember.
   */
  it('every owner is a LIVE task, compared by identity', () => {
    for (const entry of UNPORTED_CATALOG_MODULES) {
      expect(`${entry.file} owner: ${entry.owner}`).toBe(
        `${entry.file} owner: ${LIVE_TASK_IDS.includes(entry.owner) ? entry.owner : `${entry.owner} (NOT a live task)`}`
      );
    }
  });

  /**
   * The mutation guard for the assertion above.
   *
   * Without it, `LIVE_TASK_IDS.includes(...)` is a check whose failure mode is
   * untested — and this whole finding exists because a check that could not
   * fail was trusted for three tasks. A closed task's id must be REJECTED, and
   * a bare `Task ` prefix must not be enough to pass.
   */
  it('rejects a closed task, and a prefix match is not enough', () => {
    expect(LIVE_TASK_IDS).not.toContain('Task 10');
    expect(LIVE_TASK_IDS).not.toContain('Task 999');
    // The exact strings the old substring gate accepted.
    expect(LIVE_TASK_IDS.some((id) => 'Task 10'.includes(id))).toBe(false);
    // And a superstring of a live id is not a live id either — the shape the
    // first re-ownership shipped, `'Task 19 — MongoDB removal (…)'`.
    expect(LIVE_TASK_IDS).not.toContain('Task 19 — MongoDB removal (re-owned from the closed Task 10)');
    expect(LIVE_TASK_IDS).toContain('Task 19');
  });

  /**
   * Provenance lives in `reownedFrom`, and it must not leak back into `owner`.
   *
   * The container is the whole finding: accurate prose in `owner` is exactly
   * what made the closed-task comparison impossible.
   */
  it('owner carries the bare id and nothing else', () => {
    for (const entry of UNPORTED_CATALOG_MODULES) {
      expect(`${entry.file}: ${entry.owner}`).toBe(`${entry.file}: ${entry.owner.trim()}`);
      expect(`${entry.file} owner has no prose: ${/^Task [0-9]+[a-z]?$/.test(entry.owner)}`).toBe(
        `${entry.file} owner has no prose: true`
      );
    }
  });
});

describe('the matcher is exact — a substring or superstring never matches', () => {
  /**
   * The mutation this describe block exists for: rewriting `isCatalogModel` as
   * `CATALOG_MODELS.some((m) => name.includes(m))` — the shape that shipped in
   * the identifier exemption — passes every assertion above and fails these.
   */
  it('a SUPERSTRING of a catalog model is judged on its own identity', () => {
    // `TrackFingerprint` contains `Track`. It IS a catalog model, so it must
    // match — but by its own name, which the next case proves.
    expect(isCatalogModel('TrackFingerprint')).toBe(true);
    // `TrackKeyRotation` contains `TrackKey` and is NOT a catalog model.
    expect(isCatalogModel('TrackKeyRotation')).toBe(false);
    // `AlbumArtwork` contains `Album`.
    expect(isCatalogModel('AlbumArtwork')).toBe(false);
  });

  it('a SUBSTRING of a catalog model is not absorbed either', () => {
    // `Tra` is a substring of `Track`; an `endsWith`/`startsWith` matcher on the
    // wrong side would take it.
    expect(isCatalogModel('Tra')).toBe(false);
    expect(isCatalogModel('Catalog')).toBe(false);
  });

  it('a name CONTAINING a registrable model is not treated as that model', () => {
    // `UserUploadArchive` contains `UserUpload`, which IS registrable — so a
    // loose registry lookup would let a file import it unregistered.
    expect(KNOWN_NON_CATALOG.has('UserUploadArchive')).toBe(false);
    expect(KNOWN_NON_CATALOG.has('UserUpload')).toBe(true);
  });

  it('the two sets are disjoint by identity', () => {
    const overlap = [...KNOWN_NON_CATALOG].filter((name) => CATALOG_MODEL_SET.has(name));
    expect(`overlap: ${overlap.join(', ') || 'none'}`).toBe('overlap: none');
  });
});

describe('vacuity floor', () => {
  /**
   * Every property-1 assertion is an ABSENCE, so a parser returning nothing
   * satisfies all of them. These fail if the walk stops finding imports.
   */
  it('the parser finds the imports a known hybrid file actually has', () => {
    const found = modelImportsOf('services/recommendations/recommendationService.ts');
    expect(found).toEqual(['CatalogRelation', 'ListeningEvent', 'UserTasteProfile']);
  });

  it('the parser finds a TYPE-ONLY import', () => {
    /**
     * Asserted against a SOURCE STRING, not a file on disk.
     *
     * It used to read `services/stream/manifestService.ts`, whose sole model
     * import was `type ITrack` — a good example right up to the moment Task 10c
     * deleted the two adapters that needed it, at which point this floor failed
     * for a reason that had nothing to do with the parser. A floor that a
     * successful port breaks is a floor that gets weakened by whoever hits it.
     * The property under test is about the REGEX, so the fixture is a string.
     */
    expect(modelImportsIn("import type { ITrack } from '../../models/Track';")).toEqual(['Track']);
    expect(modelImportsIn("import { TrackModel } from '../models/Track';")).toEqual(['Track']);
    // A path that merely CONTAINS `models/` is not a model import.
    expect(modelImportsIn("import { x } from '../viewmodels/Track';")).toEqual([]);
  });

  it('the registry is not empty and covers the measured hybrids', () => {
    /**
     * Eighteen. It was twenty until Task 12, and this is the FIRST time this
     * floor has gone down.
     *
     * That direction matters, because Task 11's note here explains why it went
     * UP: porting a file's catalog half is what makes it hybrid and therefore
     * registrable at all, so the registry grows while the migration is in its
     * middle. It shrinks only when a vertical's OWN models leave the tree —
     * which is what Task 12 did, deleting `Podcast`, `Episode`,
     * `EpisodeProgress` and `Library` and with them the licence
     * `entityProfile.controller` and `search.controller` held to read them.
     *
     * A registry that shrank to nothing WITHOUT the owning tasks landing means
     * the walk broke, not that the work finished. Tasks 8/13/15 each remove
     * entries and this floor drops with them, deliberately, by being edited.
     */
    expect(HYBRID_MODULES.length).toBe(18);
    /**
     * Three, down from six. Task 19a cleared the three half-connected bulk
     * loaders — `backfillTrackFingerprints`, `importIsrcRegistry` and
     * `importMusicBrainzArtists` — which were never dormant: each was the write
     * half of a mechanism whose read half was already on Postgres, so its reader
     * queried an empty table and returned a confident negative.
     *
     * The three that remain are genuinely dormant. `importDiscogsReleases` and
     * `seedMusicData` fill tables nothing reads, and stay with Task 19; the
     * third is Task 13's `uploads.controller`.
     *
     * See `MINIMUM_CATALOG_MODEL_IMPORTERS`, which counts the same population.
     */
    expect(UNPORTED_CATALOG_MODULES.length).toBe(3);
  });
});
