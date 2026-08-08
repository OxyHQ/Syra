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

/** `src/`, the root every scan below walks. */
const SOURCE_ROOT = join(__dirname, '..', '..', '..');
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

describe('every rendering `websearch_to_tsquery` can produce is a valid query', () => {
  /**
   * A negated multi-word phrase renders as a PARENTHESISED GROUP, and `( … ):*`
   * is `syntax error in tsquery`. Appending `:*` unconditionally therefore 500'd
   * `/api/search` and `/api/tracks/search` on an ordinary search-box entry —
   * both call sites end in `catch → next(error)`.
   *
   * Every other fixture in this file, and in `controllers/tracks.search.test.ts`,
   * ends in a bare lexeme, which is the side of the distinction where appending
   * is valid. That is why the whole suite was green over a reachable crash: no
   * fixture sat on the other side of it. These do.
   */
  const TRAILING_PAREN_RENDERINGS = [
    'love -"glove compartment"',
    'rock -"n roll"',
    '"a b" -"c d"',
    'love or -"b c"',
  ];

  it('does not raise on a trailing negated PHRASE', async () => {
    await seedTitles('Love Song', 'Glove Compartment');

    for (const query of TRAILING_PAREN_RENDERINGS) {
      // The assertion is that this RESOLVES. Before the guard each one threw
      // `syntax error in tsquery` out of the driver.
      expect(`${query}: ${Array.isArray(await titlesMatching(query))}`).toBe(`${query}: true`);
    }
  });

  /**
   * And the negation still MEANS something — a test that only proved "no throw"
   * would pass against a helper that had started matching nothing at all.
   */
  it('still excludes the negated phrase it could not prefix', async () => {
    await seedTitles('Love Song', 'Glove Compartment Love');

    expect(await titlesMatching('love -"glove compartment"')).toEqual(['Love Song']);
  });

  /** The shapes that DO end in a lexeme keep their prefix — including phrases. */
  it('still prefixes every rendering that ends in a lexeme', async () => {
    await seedTitles('Lovers Rock', 'Something Else');

    expect(await titlesMatching('lov')).toEqual(['Lovers Rock']);
    expect(await titlesMatching('"lovers roc"')).toEqual(['Lovers Rock']);
    expect(await titlesMatching('lovers -someth')).toEqual(['Lovers Rock']);
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

describe('no catalog read orders with drizzle\'s desc()', () => {
  /**
   * `desc(col)` emits `ORDER BY col DESC`, which means `NULLS FIRST`; every
   * descending index in this schema is `DESC NULLS LAST`, because that is what
   * drizzle's index DSL `.desc()` emits. Postgres matches an ordering to an
   * index syntactically, nulls placement included, so the two never meet — the
   * index is still chosen, as a predicate scan with a full sort on top
   * (measured: `GET /api/tracks` cost 1087.00 vs 4.34).
   *
   * On a NULLABLE column it is also a behaviour inversion: `catalog_entities.
   * stats_followers` and `tracks.removed_at` are nullable, and Mongo sorted a
   * missing field LAST. `desc()` puts those rows at the FRONT of the shelf.
   *
   * The task that introduced `descNullsLast` converted its own three
   * controllers and left eleven sites in files it had also touched — two of them
   * the nullable ones, and one of them ordering the same artist list a second
   * way. That is why this is a gate and not a convention: the two spellings are
   * indistinguishable by eye and `tsc` accepts both.
   *
   * `asc()` is deliberately NOT forbidden. Postgres `ASC` already means
   * `NULLS LAST` and drizzle's `.asc()` index is `ASC NULLS LAST`, so that pair
   * matches and needs no replacement.
   */
  const APPLICATION_DIRS = ['controllers', 'services', 'utils', 'middleware', 'routes'];

  it('every descending catalog ordering uses descNullsLast', () => {
    const offenders: string[] = [];
    let scanned = 0;

    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        scanned += 1;
        const source = readFileSync(path, 'utf8')
          // Comments are blanked so prose naming `desc()` — this block included
          // — cannot trip the scan.
          .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
          .replace(/\/\/[^\n]*/g, (line) => line.replace(/[^\n]/g, ' '));
        // `(?<![.\w])` so the index DSL's `column.desc()` and the identifier
        // `descNullsLast(` are both left alone — only the bare call matches.
        for (const match of source.matchAll(/(?<![.\w])desc\([^)]*\)/g)) {
          offenders.push(`${path.slice(SOURCE_ROOT.length + 1)}: ${match[0]}`);
        }
      }
    };

    for (const directory of APPLICATION_DIRS) walk(join(SOURCE_ROOT, directory));

    // A vacuity floor: a traversal that found nothing would report no offenders
    // and read exactly like a clean tree.
    expect(scanned).toBeGreaterThanOrEqual(100);
    expect(offenders).toEqual([]);
  });
});
