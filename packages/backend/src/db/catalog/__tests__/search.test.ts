/**
 * What catalog text search MATCHES, and what it deliberately no longer matches.
 *
 * `db/catalog/search.ts` replaced a case-insensitive substring match with
 * `search_vector @@ websearch_to_tsquery('english', …)` plus a prefix on the
 * final term. That is a **ruled product decision** (Nate, 2026-08-07), taken
 * because the substring form is unindexable — a leading wildcard cannot use a
 * b-tree, `pg_trgm` is not installed — so its cost grew with the catalogue,
 * while the `search_vector` columns and their GIN indexes had been sitting
 * unread since the schema was written.
 *
 * The trade is asserted here in BOTH directions on purpose:
 *
 *   GAINED — prefix ("lov" finds "Lovers", so type-ahead works) and STEMMING
 *   ("loves" finds "Loving"), neither of which the substring match could do.
 *
 *   LOST — INFIX. "love" does NOT find "Glove". That assertion is the point of
 *   this file: it is the accepted cost, written down as an expectation so that
 *   somebody meeting it in six months fixes the EXPECTATION with a new ruling
 *   rather than quietly restoring `ilike '%q%'` and the sequential scan.
 *
 * `__tests__/containers.explain.test.ts` holds the other half — that the query
 * really reaches `tracks_search_gin`, with a recomputed-vector control proving
 * the probe can tell.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { normalizeNameKey } from '@syra/shared-types';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { catalogEntities, tracks } from '../../schema/catalog';
import { TEXT_SEARCH_CONFIG, textSearch } from '../search';
import { playableTrackFilter } from '../visibility';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

let artistId: string | undefined;

async function theArtist(): Promise<string> {
  if (artistId) return artistId;
  const name = `Search Fixture ${uuidv7()}`;
  const [row] = await getDb()
    .insert(catalogEntities)
    .values({ type: 'artist', name, nameKey: normalizeNameKey(name), source: 'upload' })
    .returning({ id: catalogEntities.id });
  if (!row) throw new Error('theArtist: insert returned no row');
  artistId = row.id;
  return artistId;
}

afterEach(() => {
  artistId = undefined;
});

async function seedTitles(...titles: string[]): Promise<void> {
  for (const title of titles) {
    await getDb().insert(tracks).values({
      title,
      artistId: await theArtist(),
      artistName: 'A Band',
      duration: 180,
      source: 'upload',
      status: 'ready',
      isAvailable: true,
    });
  }
}

/** Titles the search returns, sorted so the assertion does not depend on order. */
async function titlesMatching(query: string): Promise<string[]> {
  const rows = await getDb()
    .select({ title: tracks.title })
    .from(tracks)
    .where(and(playableTrackFilter(), textSearch(tracks.searchVector, query)));
  return rows.map((row) => row.title).sort();
}

describe('what the ruling gained', () => {
  it('matches a PREFIX of the final term, so type-ahead works', async () => {
    await seedTitles('Lovers Rock', 'Something Else');

    // "lov" is not a word in any title; the `:*` on the final term is the only
    // reason this matches at all.
    expect(await titlesMatching('lov')).toEqual(['Lovers Rock']);
  });

  it('STEMS, so a different inflection of the same word matches', async () => {
    await seedTitles('Loving You', 'Unrelated');

    // Neither "loves" nor "loved" appears anywhere in the title. The English
    // stemmer reduces all three to `love`, which the substring match could
    // never do — and which a `'simple'` configuration would not do either.
    expect(await titlesMatching('loves')).toEqual(['Loving You']);
    expect(await titlesMatching('loved')).toEqual(['Loving You']);
  });

  it('matches the artist name, which is in the same stored vector', async () => {
    await getDb().insert(tracks).values({
      title: 'Untitled',
      artistId: await theArtist(),
      artistName: 'Portishead',
      duration: 180,
      source: 'upload',
      status: 'ready',
      isAvailable: true,
    });

    expect(await titlesMatching('portishead')).toEqual(['Untitled']);
  });
});

describe('what the ruling gave up, deliberately', () => {
  /**
   * THE assertion this file exists for.
   *
   * A tsquery matches whole lexemes and prefixes of them, never an infix. The
   * old substring match found "Glove" for "love" and this one does not. If you
   * are here because a user reported it: that is the ruled behaviour, and
   * changing it back means an unindexed scan on a public endpoint. Get a new
   * ruling and change this expectation with the code — do not delete it.
   */
  it('does NOT match an infix: "love" no longer finds "Glove"', async () => {
    await seedTitles('Glove Compartment', 'Love Song');

    // Vacuity floor: the query really does match something, so "Glove" being
    // absent is a statement about infixes and not about a broken query.
    expect(await titlesMatching('love')).toEqual(['Love Song']);
  });

  /**
   * A query of nothing but stopwords is an EMPTY tsquery, and
   * `prefixTsquery` turns that into `null::tsquery` rather than the syntax
   * error `('' || ':*')::tsquery` would raise. Matching nothing is the
   * fail-closed answer; the substring match returned every title containing
   * "the".
   */
  it('matches nothing for a query that is only stopwords, instead of erroring', async () => {
    await seedTitles('The Great Escape');

    expect(await titlesMatching('the')).toEqual([]);
  });
});

describe('the query and the stored columns use the same configuration', () => {
  /**
   * The stored vectors are built by `to_tsvector('english', …)` and the query
   * by `websearch_to_tsquery('english', …)`. If those two configurations ever
   * disagree, the stemming test above goes red — but only for the tables that
   * test covers, and only if somebody notices which assertion broke.
   *
   * This is the cheap, total version: every `to_tsvector(` in `db/schema/` must
   * name {@link TEXT_SEARCH_CONFIG}. It catches a NEW table added with a
   * different configuration, which no behavioural test would cover until
   * somebody wrote one.
   */
  it('every generated search_vector in db/schema names the same configuration', () => {
    const schemaDir = join(__dirname, '..', '..', 'schema');
    const files = readdirSync(schemaDir).filter((name) => name.endsWith('.ts'));

    // A vacuity floor: a traversal that found no files, or no vectors, would
    // report zero mismatches and read exactly like a clean tree.
    expect(files.length).toBeGreaterThanOrEqual(5);

    const configs = files.flatMap((name) =>
      [...readFileSync(join(schemaDir, name), 'utf8').matchAll(/to_tsvector\('([^']+)'/g)].map(
        (match) => `${name}: ${match[1]}`
      )
    );

    expect(configs.length).toBeGreaterThanOrEqual(5);
    expect(configs.filter((entry) => !entry.endsWith(`: ${TEXT_SEARCH_CONFIG}`))).toEqual([]);
  });
});
