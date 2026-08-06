/**
 * Catalog text search, on the `search_vector` columns the schema provisioned.
 *
 * ## The ruling this implements, and what it costs
 *
 * Every search site was a case-insensitive SUBSTRING match — Mongo's
 * `new RegExp(q, 'i')`, ported briefly as `ilike '%q%'`. Both are unindexable:
 * a leading wildcard cannot use a b-tree and `pg_trgm` is not installed, so the
 * query scanned every playable row and the cost grew with the catalogue.
 *
 * `schema/catalog.ts` and `schema/library.ts` declare a generated
 * `search_vector` on `tracks`, `albums`, `catalog_entities` and `playlists`,
 * each with a GIN index, and until this module nothing read them. The product
 * decision (Nate, 2026-08-07) is to make them the search path:
 *
 *   GAINED — a GIN index, so cost is a function of matches rather than of
 *   catalogue size; and STEMMING, so "loves" finds "love" and "loving" finds
 *   "loved". The substring match never did that.
 *
 *   LOST — INFIX. "love" no longer finds "Glove", because a tsquery matches
 *   whole lexemes and, with {@link prefixTsquery}, prefixes of the final one.
 *   This is a deliberate, ruled product change, not an oversight, and
 *   `__tests__/search.test.ts` asserts it in BOTH directions so nobody
 *   "restores" it into a sequential scan.
 *
 *   ALSO LOST, and worth knowing — STOPWORDS. `websearch_to_tsquery('english',
 *   'the')` is an EMPTY tsquery, so a query of nothing but stopwords matches
 *   nothing where the substring match matched everything containing "the".
 *   Handled explicitly below rather than left to blow up.
 *
 * ## Why the configuration is written out
 *
 * `to_tsvector('english', …)` builds the stored columns — spelled with the
 * literal because the unqualified two-argument form reads
 * `default_text_search_config` and is only STABLE, not IMMUTABLE, which a
 * generated column cannot use. The QUERY side has to name the same
 * configuration or the two disagree about stemming: `websearch_to_tsquery(
 * 'simple', 'loves')` produces the lexeme `loves`, which is not in a vector
 * built by the English stemmer as `love`. The match then silently returns
 * nothing for exactly the inputs stemming was supposed to help.
 *
 * `__tests__/search.test.ts` holds {@link TEXT_SEARCH_CONFIG} against every
 * `to_tsvector(...)` in `db/schema/`, so the two cannot drift.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * The text-search configuration BOTH sides use.
 *
 * Exported for the gate rather than for callers — every query below writes the
 * literal, because `websearch_to_tsquery` is IMMUTABLE only when the
 * configuration is a constant, and that is what lets the planner fold the whole
 * expression into a single scan key for the GIN index.
 */
export const TEXT_SEARCH_CONFIG = 'english';

/**
 * The user's query as a `tsquery`, with a PREFIX match on the final term.
 *
 * `websearch_to_tsquery` is the parser to use for a search box: it accepts what
 * people actually type — bare words, `"quoted phrases"`, `-negation`, `or` —
 * and never throws on malformed input, unlike `to_tsquery`. What it does not do
 * is prefix matching, so `"lov"` would find nothing while the user is still
 * typing.
 *
 * The prefix is appended through the tsquery's own TEXT rendering
 * (`'love' & 'song'` → `'love' & 'song':*`) rather than by pasting `:*` onto
 * the user's input, which would let a raw `'` or `!` reach the tsquery parser.
 * Everything the user typed has already been through `websearch_to_tsquery` by
 * then; only the four characters `:*` are ours.
 *
 * The empty case is explicit: a query of nothing but stopwords renders as `''`,
 * and `('' || ':*')::tsquery` is a syntax error rather than an empty result.
 * `null::tsquery` makes the `@@` NULL, which a `WHERE` treats as false — the
 * fail-closed answer, and the one a user typing "the" should get from a lexeme
 * search.
 */
export function prefixTsquery(query: string): SQL {
  return sql`
    case when websearch_to_tsquery('english', ${query})::text = '' then null::tsquery
         else (websearch_to_tsquery('english', ${query})::text || ':*')::tsquery
    end
  `;
}

/**
 * "This row matches the user's search" — a condition over a stored
 * `search_vector`, composable with `and()` like every other catalog predicate.
 *
 * The column must be the STORED generated column, never a `to_tsvector(...)`
 * recomputed in the query: the GIN indexes are on the columns, so recomputing
 * produces an expression no index covers and the scan goes sequential with no
 * error and no warning. `__tests__/containers.explain.test.ts` proves the
 * Bitmap Index Scan rather than assuming it.
 */
export function textSearch(searchVector: PgColumn, query: string): SQL {
  return sql`${searchVector} @@ ${prefixTsquery(query)}`;
}
