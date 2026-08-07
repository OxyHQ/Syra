import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import mongoose from 'mongoose';
import { albumSchema, artistSchema, trackSchema } from '@syra/shared-types';
import { ArtistModel } from './CatalogEntity';
import { TrackModel } from './Track';
import { AlbumModel } from './Album';

/**
 * Every field the zod DTO declares must resolve to a real Mongoose path.
 *
 * ## The bug this exists to prevent, which actually happened
 *
 * Eleven enrichment fields were added to the zod `artistSchema` and not to
 * `ArtistDiscriminatorSchema`. Mongoose strict mode DISCARDS a `$set` on an
 * undeclared path — it does not throw and it does not warn — while `IArtist`,
 * derived from the zod type, made every one of those writes typecheck. So:
 *
 *  - `tsc` was clean.
 *  - The enrichment ran, returned `enriched`, and logged eleven fields written.
 *  - The database kept none of them.
 *
 * It surfaced only because an idempotency test failed: the second run rewrote
 * the same fields, because the first run's write never landed, so the
 * "fill gaps only" check found the same gaps forever. Left alone it would also
 * have grown an UNBOUNDED `sources[]` — one provenance entry appended per pass,
 * for fields that never persist.
 *
 * This is invisible to tsc BY CONSTRUCTION: the zod schema is the source of the
 * TypeScript type, so the type can never disagree with itself. Only a runtime
 * comparison against the Mongoose schema can see the gap.
 *
 * ## What counts as a legitimate absence
 *
 * A DTO is not a document. `id`, timestamps and derived values are computed by
 * the serializer and correctly have no stored path. Those are listed per model
 * in {@link DTO_ONLY} with a reason — an allowlist, so adding to it is a visible
 * decision rather than a silent hole.
 */

/** Fields a DTO legitimately exposes without storing. */
const DTO_ONLY: Record<string, string[]> = {
  // `id` is `_id` stringified; timestamps are set by `{ timestamps: true }` and
  // serialised to ISO strings, so they exist but not as declared paths.
  common: ['id', '_id', 'createdAt', 'updatedAt'],
  // Derived by the serializer from playability + a regenerable source.
  Track: ['previewAvailable', 'kind'],
  // `stats` is stored, but `monthlyListeners` is computed on read.
  Artist: [],
  Album: [],
  // `UserUpload` was here and is gone with its model: Task 13 ported the locker
  // to drizzle, where this whole class of bug cannot occur — a column that does
  // not exist is a `tsc` error at the write site, not a silently dropped `$set`.
};

/**
 * Resolve a possibly-dotted path through single-nested sub-schemas.
 *
 * `schema.path('links.wikidata')` does not resolve for a single-nested
 * subdocument — the parent path holds its own `Schema`, so the walk has to
 * descend explicitly. Getting this wrong would make the whole check vacuous by
 * reporting every nested field as missing.
 */
function resolvesToMongoosePath(schema: mongoose.Schema, dotted: string): boolean {
  if (schema.path(dotted)) return true;

  const [head, ...rest] = dotted.split('.');
  if (head === undefined || rest.length === 0) return false;

  const parent = schema.path(head);
  if (!parent) return false;

  const nested = (parent as unknown as { schema?: mongoose.Schema }).schema;
  if (!nested) return false;

  return resolvesToMongoosePath(nested, rest.join('.'));
}

/** Unwrap optional/nullable/default wrappers to reach the underlying type. */
function unwrap(type: z.ZodTypeAny): z.ZodTypeAny {
  let current = type;
  for (let depth = 0; depth < 10; depth += 1) {
    const inner = (current as unknown as { unwrap?: () => z.ZodTypeAny }).unwrap;
    const def = (current as unknown as { _def?: { innerType?: z.ZodTypeAny } })._def;
    if (typeof inner === 'function') current = inner.call(current);
    else if (def?.innerType) current = def.innerType;
    else break;
  }
  return current;
}

/** Every leaf path the DTO declares, descending one level into nested objects. */
function zodPaths(schema: z.ZodObject<z.ZodRawShape>, prefix = ''): string[] {
  const paths: string[] = [];

  for (const [key, value] of Object.entries(schema.shape)) {
    const full = prefix ? `${prefix}.${key}` : key;
    const inner = unwrap(value as z.ZodTypeAny);

    // Only descend into plain objects. An array of objects is stored as one
    // array path, and comparing its element fields would be a different check.
    if (inner instanceof z.ZodObject && prefix === '') {
      paths.push(...zodPaths(inner as z.ZodObject<z.ZodRawShape>, full));
      continue;
    }
    paths.push(full);
  }

  return paths;
}

const CASES: Array<{
  name: string;
  dto: z.ZodObject<z.ZodRawShape>;
  model: mongoose.Model<never>;
}> = [
  { name: 'Artist', dto: artistSchema as z.ZodObject<z.ZodRawShape>, model: ArtistModel as unknown as mongoose.Model<never> },
  { name: 'Track', dto: trackSchema as z.ZodObject<z.ZodRawShape>, model: TrackModel as unknown as mongoose.Model<never> },
  { name: 'Album', dto: albumSchema as z.ZodObject<z.ZodRawShape>, model: AlbumModel as unknown as mongoose.Model<never> },
];

describe('every zod DTO field resolves to a Mongoose path', () => {
  it('the scan is not vacuous', () => {
    // Every assertion below is "nothing missing". A walker that returned no
    // paths, or a resolver that said yes to everything, would report exactly
    // that — so prove both halves still work before trusting the result.
    for (const testCase of CASES) {
      expect(zodPaths(testCase.dto).length).toBeGreaterThan(10);
    }

    const artistSchemaPaths = zodPaths(artistSchema as z.ZodObject<z.ZodRawShape>);
    // Nested descent must actually happen, or nested drift is invisible.
    expect(artistSchemaPaths).toContain('links.wikidata');
    expect(artistSchemaPaths).toContain('externalIds.wikidataId');

    // And the resolver must be capable of saying NO.
    expect(resolvesToMongoosePath(ArtistModel.schema, 'definitelyNotAField')).toBe(false);
    expect(resolvesToMongoosePath(ArtistModel.schema, 'links.definitelyNotAField')).toBe(false);
  });

  for (const testCase of CASES) {
    it(`${testCase.name}: no field is declared in the DTO and dropped by the model`, () => {
      const allowed = new Set([
        ...(DTO_ONLY.common ?? []),
        ...(DTO_ONLY[testCase.name] ?? []),
      ]);

      const missing = zodPaths(testCase.dto)
        .filter((dotted) => !allowed.has(dotted))
        .filter((dotted) => !allowed.has(dotted.split('.')[0] ?? ''))
        .filter((dotted) => !resolvesToMongoosePath(testCase.model.schema, dotted));

      expect(
        missing,
        `${testCase.name}: these fields exist on the DTO and have NO Mongoose path, so ` +
          'Mongoose strict mode discards every write to them silently. Add them to the ' +
          'schema, or to DTO_ONLY if the serializer derives them.',
      ).toEqual([]);
    });
  }
});
