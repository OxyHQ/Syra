import { expect } from 'bun:test';

/**
 * The assertion the EXPLAIN suites share: **every index a plan used is one this
 * test accepts.**
 *
 * ## Why not `toContain('<prefix>_')`, which this replaces
 *
 * `indexesIn(probe)` joins every index name in the plan into one string, so
 * `toContain('episodes_podcast_id_')` asks "does an acceptable index appear
 * ANYWHERE in this plan". It cannot see an UNACCEPTABLE index appearing beside
 * it — a plan that reached the right index and also scanned a wrong one passes.
 * That is the hole a prefix leaves even when the prefix itself is well chosen.
 *
 * A subset check asks the other question, which is the one worth asking: is
 * there anything here I did not expect? It is strictly tighter than a prefix and
 * it keeps whatever looseness the caller actually wants, because the caller
 * names the alternatives instead of hoping a substring covers exactly them.
 *
 * ## Why not an exact name either
 *
 * Because for several of these probes the choice among equivalent indexes is a
 * COST ESTIMATE, not a property of the query, and pinning it produces a test
 * that fails for a reason nobody can act on. That is measured, not theoretical —
 * three recorded tie-breaks in these suites have already moved:
 *
 *  - `podcasts.explain`: an earlier version demanded
 *    `episodes_podcast_id_pub_date_idx`; five runs then gave
 *    `episodes_podcast_id_guid_key`. Today it gives `pub_date_idx` again.
 *  - `containers.explain`: `albumHasPlayable` recorded `tracks_play_count_idx`;
 *    it now chooses `tracks_mood_idx`.
 *  - `containers.explain`: `browsePopularTracks`/`browseGenreCards` recorded
 *    `tracks_created_at_idx`; both now choose `tracks_mood_idx`.
 *
 * All three are legitimate: the candidates are partial indexes covering the same
 * rows, so the planner is choosing among equals on size and statistics — and
 * this database is shared with other agents' suites, so those move underneath
 * the run. Naming one would be asserting a coin flip.
 *
 * So: name the SET. Exactly one member means an exact assertion; several means
 * "any of these, and nothing else", which is what most of these probes actually
 * mean and could not previously say.
 */
export function expectIndexesWithin(
  probe: string,
  used: string,
  accepted: readonly string[],
): void {
  const names = used.split(', ').map((name) => name.trim()).filter(Boolean);

  /**
   * A plan with no index scan at all must FAIL, not pass vacuously. A subset
   * check is satisfied by the empty set, which is precisely the shape of the
   * failure these suites exist to catch — `toContain` happened to reject it
   * (the empty string contains no prefix), so this has to be restored
   * explicitly rather than inherited.
   */
  expect(
    `${probe}: used an index? ${names.length > 0}`,
    `${probe} produced NO index scan at all. Its plan was: ${used || '(none)'}`,
  ).toBe(`${probe}: used an index? true`);

  expect(
    names.filter((name) => !accepted.includes(name)),
    `${probe} used indexes this test does not accept.\n`
      + `  used:     ${names.join(', ')}\n`
      + `  accepted: ${accepted.join(', ')}\n`
      + 'Either the plan regressed, or the accepted set needs a new member with a reason.',
  ).toEqual([]);
}

/**
 * The `tracks` indexes whose partial `WHERE` clause IS the playability predicate
 * (`is_available = true and copyright_removed = false`).
 *
 * They cover identical rows and differ only in key, so a query that filters on
 * playability and orders by something none of them provides can enter through
 * ANY of them — the planner picks on cost. Every probe that reads "the playable
 * catalogue" accepts the whole set for that reason.
 *
 * Naming the set rather than matching `tracks_` is the tightening: `tracks_`
 * admits all thirteen indexes on the table, including `tracks_pkey` and
 * `tracks_sha256_idx`, neither of which would mean what those probes assert.
 *
 * **Kept honest by {@link PLAYABILITY_PARTIAL_INDEX_SQL}**, which re-derives this
 * list from the live database. A hand-written list of index names is exactly the
 * registry-that-does-not-discover shape: it goes stale the day someone adds an
 * eighth partial index, and the symptom is a legitimate plan failing. I got this
 * list wrong on the first attempt — `tracks_album_id_idx` and
 * `tracks_artist_id_album_id_idx` are partial on the same predicate and I had
 * omitted both, which the probes caught within one run.
 */
export const PLAYABLE_TRACK_PARTIAL_INDEXES = [
  'tracks_album_id_idx',
  'tracks_artist_id_album_id_idx',
  'tracks_created_at_idx',
  'tracks_genre_idx',
  'tracks_mood_idx',
  'tracks_play_count_idx',
  'tracks_popularity_idx',
] as const;

/**
 * Re-derives {@link PLAYABLE_TRACK_PARTIAL_INDEXES} from `pg_indexes`.
 *
 * `pg_indexes` lists INDEXES only — check constraints and foreign keys share the
 * `tracks_` namespace but never appear in a plan, so counting names rather than
 * indexes overstates the ambiguity (29 names against 13 indexes on this table).
 */
export const PLAYABILITY_PARTIAL_INDEX_SQL = `
  select indexname from pg_indexes
  where schemaname = 'public' and tablename = 'tracks'
    and indexdef like '%is_available = true%'
    and indexdef like '%copyright_removed = false%'
  order by indexname
`;

/**
 * The two indexes on `tracks` that lead with `artist_id`.
 *
 * `tracks_artist_id_idx` is migration `0017`'s PLAIN index, and the only
 * artist-keyed one that is not partial — it exists because the partial indexes
 * cannot serve a query whose predicate does not imply theirs, which is the
 * artist's own dashboard showing taken-down work.
 * `tracks_artist_id_album_id_idx` is partial and leads with the same column, so
 * for a query that does carry the playability predicate the planner may take
 * either.
 */
export const ARTIST_KEYED_TRACK_INDEXES = [
  'tracks_artist_id_idx',
  'tracks_artist_id_album_id_idx',
] as const;
