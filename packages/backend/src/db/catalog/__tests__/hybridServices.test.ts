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
 *      unregistered one fails as an oversight, a registered one that is gone
 *      fails as STALE.
 *
 * Property 2's second direction is the whole point. An exemption list that only
 * checks "everything here is allowed" is satisfied forever by an entry nobody
 * needs any more, which is how `LAST_GENESIS_MIGRATION_TAG` sat three
 * migrations behind and how the identifier exemption outlived its offender.
 * This one fails the moment Task 11 removes `PlaylistModel` from `radioSeed.ts`
 * and nobody updates the registry.
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  CATALOG_MODELS,
  HYBRID_SERVICES,
  NON_CATALOG_MODEL_OWNERS,
  OWNING_TASKS,
  UNPORTED_CATALOG_SERVICES,
  type CatalogModel,
  type NonCatalogModel,
} from '../hybridServices';

const SRC = join(import.meta.dir, '..', '..', '..');

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
function modelImportsOf(relativePath: string): string[] {
  const source = readFileSync(join(SRC, relativePath), 'utf8');
  const found = new Set<string>();
  for (const match of source.matchAll(/from\s+'(?:\.\.?\/)+models\/([A-Za-z0-9_]+)'/g)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return [...found].sort();
}

const CATALOG_MODEL_SET = new Set<string>(CATALOG_MODELS);
const KNOWN_NON_CATALOG = new Set<string>(Object.keys(NON_CATALOG_MODEL_OWNERS));

/** Exact-equality membership. Never `includes`, never `endsWith`. */
function isCatalogModel(name: string): boolean {
  return CATALOG_MODEL_SET.has(name);
}

describe('the registry is well formed', () => {
  it('registers every hybrid file exactly once', () => {
    const files = HYBRID_SERVICES.map((entry) => entry.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it('registers only models with a known owning task', () => {
    for (const entry of HYBRID_SERVICES) {
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
  for (const entry of HYBRID_SERVICES) {
    it(`${entry.file} is off the catalog models`, () => {
      const offending = modelImportsOf(entry.file).filter(isCatalogModel);
      // Named in the message so a failure says WHICH model, not "expected [] to equal [X]".
      expect(`${entry.file}: ${offending.join(', ') || 'none'}`).toBe(`${entry.file}: none`);
    });
  }
});

describe('property 2 — a registered file imports exactly its registered models', () => {
  for (const entry of HYBRID_SERVICES) {
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
  for (const entry of UNPORTED_CATALOG_SERVICES) {
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

  it('names an owner for every entry', () => {
    for (const entry of UNPORTED_CATALOG_SERVICES) {
      expect(`${entry.file}: ${entry.owner}`).toContain('Task ');
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
    expect(found).toEqual(['CatalogRelation', 'Library', 'ListeningEvent', 'UserTasteProfile']);
  });

  it('the parser finds a TYPE-ONLY import', () => {
    // `manifestService.ts` imports `type ITrack` and nothing else from models.
    // A parser that skipped type imports would call the one file whose type
    // import is the actual defect clean.
    expect(modelImportsOf('services/stream/manifestService.ts')).toEqual(['Track']);
  });

  it('the registry is not empty and covers the measured hybrids', () => {
    // Ten, counted from the ported tree. A registry that shrank to nothing
    // without the owning tasks landing means the walk broke, not that the work
    // finished — Tasks 11/13/15 each remove entries and this floor drops with
    // them, deliberately, by being edited when that happens.
    expect(HYBRID_SERVICES.length).toBe(10);
    expect(UNPORTED_CATALOG_SERVICES.length).toBe(5);
  });
});
