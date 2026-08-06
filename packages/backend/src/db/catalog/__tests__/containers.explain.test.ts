/**
 * What the PLANNER does with the container queries — not what the schema
 * declares.
 *
 * A definition assertion (`pg_indexes` contains a row named X) checks what was
 * written down. It cannot tell an index that serves a query from an index that
 * merely mentions the right column, and on this branch that difference has
 * already shipped: Task 6 landed three partial indexes whose comments claimed a
 * query they could not serve, with a gate that asserted the wrong property and
 * so CERTIFIED the defect.
 *
 * The album path here is the next instance, caught this way. `schema/catalog.ts`
 * shipped `tracks_artist_id_album_id_idx` on `(artist_id, album_id)` and no
 * standalone `album_id` index. A definition check for "some index covers
 * album_id" passes on the compound one. The planner does not: Postgres 17 has no
 * index skip scan, so a query keyed on `album_id` alone can only scan the whole
 * partial index. Measured on 60,000 seeded tracks, `GET /albums/:id/tracks` read
 * 190 buffers where 9 sufficed, and proving an album has NO playable track —
 * the worst case — read 183. Migration `0016` adds `tracks_album_id_idx`; this
 * asserts the planner reaches it.
 *
 * ## Why this seeds, and why it rolls back
 *
 * The first version of this file ran against whatever the database happened to
 * hold, which locally is nothing. On an empty table every partial index on
 * `tracks` has identical statistics, so the planner's choice among them is
 * near-arbitrary — the probes passed, and then chose `tracks_genre_idx` for
 * three of the same queries the moment an unrelated index was dropped. A test
 * whose expected value depends on which of several indistinguishable plans the
 * planner happens to pick is a coin flip, not a measurement.
 *
 * So everything below runs inside ONE transaction that seeds a catalogue with
 * real cardinality, `ANALYZE`s it, EXPLAINs every query, and then ROLLS BACK.
 * Nothing is committed, so no fixture row can be left behind on a database other
 * suites share — the cleanup is the rollback, not a `delete` that could itself
 * fail.
 *
 * `set local enable_seqscan = off` is the same technique
 * `db/__tests__/gates.test.ts` uses for its referential-integrity probes, and is
 * load-bearing for the same two reasons: the setting must reach the same pooled
 * connection as the `explain`, and `set local` unwinds at commit so no planner
 * setting leaks even if this throws.
 *
 * ## The control
 *
 * A predicate no index serves must STILL report a seq scan under the same
 * setting. Without that, "no Seq Scan" could mean the indexes work or could mean
 * the probe stopped reading plans, and the two look identical from a green run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  and,
  asc,
  desc,
  eq,

  inArray,
  isNotNull,
  ne,

  sql,
  type SQLWrapper,
} from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb } from '../../postgres';
import { albums, catalogEntities, tracks } from '../../schema/catalog';
import { playlistTracks, playlists } from '../../schema/library';
import {
  ALBUM_TRACK_ORDER,
  playableAlbumTracksWhere,
  playableAlbumsWhere,
  playableArtistsWhere,
  playablePlaylistsWhere,
  descNullsLast,
  imageFirst,
} from '../containers';
import { textSearch } from '../search';
import { playableTrackFilter } from '../visibility';

/** Thrown to roll the seeding transaction back once every plan is collected. */
class Rollback extends Error {}

/** Ids the seed writes, all carrying this prefix. Never committed. */
const MARKER = 'explain-probe';

const PROBE_ALBUM = `${MARKER}-alb-7`;

/** Plan text by probe name, collected once in `beforeAll`. */
const plans = new Map<string, string>();

/** Rows actually visible in `tracks` inside the seeding transaction. */
let seededRowCount = 0;

/** Columns of `tracks` that `pg_stats` knew about after the seed's `ANALYZE`. */
let analyzedColumnCount = 0;

/**
 * A catalogue with enough cardinality for the planner to have a real preference:
 * 200 artists, 400 albums, 4,000 tracks, 200 playlists, 4,000 playlist entries.
 * Every seventh album is given only unplayable tracks so the container
 * predicates have work to do rather than matching everything.
 *
 * ## `created_at` and `play_count` VARY, and that is load-bearing
 *
 * They were left to their column defaults, which meant `now()` and `0` — and
 * `now()` is the TRANSACTION's timestamp, so all 4,000 rows shared one instant
 * and `play_count` was constant across the whole table. A column with one
 * distinct value makes its ordered index worth nothing to the planner, so
 * `tracks_created_at_idx` and `tracks_play_count_idx` cost the same as each
 * other for a `order by created_at desc limit 20` — no sort avoided either way.
 *
 * The symptom was a probe that passed, then chose the other index on the next
 * run with no relevant change. That reads as planner flakiness and is not: it is
 * a fixture sitting on the wrong side of the distinction the probe exists to
 * make. Same shape as the tidy-fixture rule for narrowing conditions — ask what
 * input makes the two candidates disagree, and put a fixture there.
 */
async function seed(tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]): Promise<void> {
  await executeRows(
    tx,
    sql`insert into image_assets (id, s3_key, filename, content_type, byte_size, owner_type)
        select ${MARKER} || '-img-' || g, ${MARKER} || '/' || g, g || '.jpg', 'image/jpeg', 1000, 'album'
        from generate_series(1, 400) g`
  );
  await executeRows(
    tx,
    sql`insert into catalog_entities (id, type, name, name_key, source, popularity)
        select ${MARKER} || '-art-' || g, 'artist', ${MARKER} || ' artist ' || g,
               ${MARKER} || '-artist' || g, 'upload', g % 101
        from generate_series(1, 200) g`
  );
  await executeRows(
    tx,
    sql`insert into albums (id, title, artist_id, artist_name, release_date, cover_art_id, popularity)
        select ${MARKER} || '-alb-' || g, 'Album ' || g,
               ${MARKER} || '-art-' || (1 + (g % 200)), 'Artist', '2020-01-01',
               ${MARKER} || '-img-' || g, g % 101
        from generate_series(1, 400) g`
  );
  await executeRows(
    tx,
    sql`insert into tracks (id, title, artist_id, artist_name, album_id, duration, source, status,
                            popularity, is_available, copyright_removed, genre, mood,
                            play_count, created_at)
        select ${MARKER} || '-t-' || g,
               'Track ' || g || case when g % 100 = 0 then ' zqxwv' else '' end,
               ${MARKER} || '-art-' || (1 + (g % 200)), 'Artist',
               ${MARKER} || '-alb-' || (1 + (g % 400)), 200, 'upload', 'ready', g % 101,
               case when (1 + (g % 400)) % 7 = 0 then false else true end,
               false,
               (array['rock','pop','jazz','ambient','hiphop'])[1 + (g % 5)],
               (array['chill','energetic','sad','happy'])[1 + (g % 4)],
               g,
               now() - (g || ' minutes')::interval
        from generate_series(1, 4000) g`
  );
  await executeRows(
    tx,
    sql`insert into playlists (id, name, owner_oxy_user_id, owner_username, visibility, followers)
        select ${MARKER} || '-pl-' || g, 'Playlist ' || g, 'oxy-' || g, 'user' || g, 'public', g
        from generate_series(1, 200) g`
  );
  await executeRows(
    tx,
    sql`insert into playlist_tracks (id, playlist_id, track_id, added_at, position)
        select ${MARKER} || '-pt-' || p || '-' || n,
               ${MARKER} || '-pl-' || p,
               ${MARKER} || '-t-' || (1 + ((p * 17 + n * 31) % 4000)),
               now(), n
        from generate_series(1, 200) p, generate_series(0, 19) n`
  );
  // Statistics, not just rows: without this the planner still costs every table
  // as if it were empty and the seed changes nothing.
  await executeRows(
    tx,
    sql`analyze tracks, albums, catalog_entities, playlists, playlist_tracks`
  );
}

beforeAll(async () => {
  process.env.DATABASE_URL ||= process.env.TEST_DATABASE_URL;
  await connectPostgres();

  try {
    await getDb().transaction(async (tx) => {
      await executeRows(tx, sql`set local enable_seqscan = off`);
      const [setting] = await executeRows<{ enable_seqscan: string }>(tx, sql`show enable_seqscan`);
      // Asserted, not assumed: a `set` that landed on a different pooled
      // connection would make every probe report a seq scan and read as a real
      // regression rather than a broken harness.
      expect(setting.enable_seqscan).toBe('off');

      await seed(tx);
      const [seeded] = await executeRows<{ total: number }>(
        tx,
        sql`select count(*)::int as total from tracks`
      );
      seededRowCount = seeded.total;
      const [analyzed] = await executeRows<{ total: number }>(
        tx,
        sql`select count(*)::int as total from pg_stats where tablename = 'tracks'`
      );
      analyzedColumnCount = analyzed.total;

      const probes: Record<string, SQLWrapper> = {
        // Each probe is the query the module actually issues: the module's own
        // exported condition, plus the ORDER BY and LIMIT the finders apply.
        // Measuring the bare WHERE would measure a plan nothing runs — a LIMIT
        // in particular can change which plan the planner picks.
        albumTracks: tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(playableAlbumTracksWhere(PROBE_ALBUM))
          .orderBy(...ALBUM_TRACK_ORDER),
        albumHasPlayable: tx
          .select({ id: albums.id })
          .from(albums)
          .where(playableAlbumsWhere())
          .orderBy(desc(albums.popularity))
          .limit(20),
        artistHasPlayable: tx
          .select({ id: catalogEntities.id })
          .from(catalogEntities)
          .where(playableArtistsWhere())
          .orderBy(desc(catalogEntities.popularity))
          .limit(20),
        playlistHasPlayable: tx
          .select({ id: playlists.id })
          .from(playlists)
          .where(playablePlaylistsWhere())
          .orderBy(desc(playlists.followers))
          .limit(20),
        // ── Task 10c-3's controller queries ──────────────────────────────
        //
        // Each is the query the handler actually issues, ORDER BY and LIMIT
        // included, for the reason stated above: the limit changes which plan
        // the planner picks, so measuring a bare WHERE measures a plan nothing
        // runs.
        //
        // `GET /api/browse/popular/tracks` and `/charts`.
        browsePopularTracks: tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(playableTrackFilter())
          .orderBy(
            imageFirst(tracks.coverArtId),
            descNullsLast(tracks.popularity),
            descNullsLast(tracks.playCount),
            descNullsLast(tracks.createdAt)
          )
          .limit(20),
        // `GET /api/browse/genres/:genre/tracks`.
        browseGenreTracks: tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(and(playableTrackFilter(), eq(tracks.genre, 'rock')))
          .orderBy(
            imageFirst(tracks.coverArtId),
            descNullsLast(tracks.popularity),
            descNullsLast(tracks.playCount),
            descNullsLast(tracks.createdAt)
          )
          .limit(50),
        // `GET /api/browse/genres` — the genre cards. `distinct on` plus the
        // matching leading `order by` is what turns Mongo's 1 + N round trips
        // (a `distinct`, then a sorted `find().limit(1)` per genre) into one.
        browseGenreCards: tx
          .selectDistinctOn([tracks.genre], { genre: tracks.genre, coverArtId: tracks.coverArtId })
          .from(tracks)
          .where(and(playableTrackFilter(), isNotNull(tracks.genre), ne(tracks.genre, '')))
          .orderBy(
            tracks.genre,
            imageFirst(tracks.coverArtId),
            descNullsLast(tracks.popularity),
            descNullsLast(tracks.playCount)
          )
          .limit(20),
        // `GET /api/tracks` — newest first.
        tracksListing: tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(playableTrackFilter())
          .orderBy(descNullsLast(tracks.createdAt))
          .limit(20),
        // `GET /api/tracks/:id`.
        trackById: tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(and(eq(tracks.id, `${MARKER}-t-7`), playableTrackFilter()))
          .limit(1),
        // `GET /api/library/tracks` and `/recently-played` — the liked/recent
        // ids resolved in one `in (…)`.
        libraryTracksByIds: tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(
            and(
              playableTrackFilter(),
              inArray(tracks.id, [`${MARKER}-t-1`, `${MARKER}-t-2`, `${MARKER}-t-3`])
            )
          ),
        // `GET /api/albums` — the public album listing.
        albumsListing: tx
          .select({ id: albums.id })
          .from(albums)
          .where(playableAlbumsWhere())
          .orderBy(descNullsLast(albums.releaseDate), descNullsLast(albums.createdAt))
          .limit(20),
        /**
         * The search PREDICATE alone — no playability filter, no ORDER BY.
         *
         * This is where the GIN index is proved, because it is the only probe
         * with no alternative for the planner to weigh; the composed queries
         * below legitimately prefer a partial index at this seed size.
         *
         * This comment used to describe the `ilike` port and claim the probe
         * asserted a Seq Scan — the body was rewritten to `textSearch` in the
         * same commit that added the ruling, and the prose was left behind
         * saying the opposite of the assertion beneath it. Corrected, and worth
         * a line: it is the recurring class this suite exists to catch, in the
         * file that is the ruling's own evidence.
         */
        searchPredicateOnly: tx
          .select({ total: sql`count(*)` })
          .from(tracks)
          .where(textSearch(tracks.searchVector, 'zqxwv')),
        // `countTracks` — the second query every non-preview search issues, and
        // the one where the index choice is unambiguous: no ORDER BY and no
        // LIMIT, so the planner has no ordered-scan alternative to weigh.
        trackSearchCount: tx
          .select({ total: sql`count(*)` })
          .from(tracks)
          .where(and(playableTrackFilter(), textSearch(tracks.searchVector, 'zqxwv'))),
        // The paged listing, which DOES have an ordered alternative.
        trackSearch: tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(and(playableTrackFilter(), textSearch(tracks.searchVector, 'zqxwv')))
          .orderBy(descNullsLast(tracks.popularity), descNullsLast(tracks.createdAt))
          .limit(20),
        // The same query with the vector RECOMPUTED instead of read from the
        // stored column — the mistake that silently costs the index. Kept as a
        // control beside the real probe so "the GIN index was used" is measured
        // against a case where it cannot be.
        trackSearchRecomputed: tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(
            and(
              playableTrackFilter(),
              sql`to_tsvector('english', ${tracks.title}) @@ websearch_to_tsquery('english', 'zqxwv')`
            )
          )
          .limit(20),
        // The control: `tracks.comment` carries no index, so the planner has
        // nothing to choose even with sequential scans discouraged.
        unindexedControl: tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(eq(tracks.comment, 'probe-no-index')),
      };

      for (const [name, query] of Object.entries(probes)) {
        const rows = await executeRows<{ 'QUERY PLAN': string }>(
          tx,
          sql`explain ${query}`
        );
        plans.set(name, rows.map((row) => row['QUERY PLAN']).join('\n'));
      }

      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
});

afterAll(async () => {
  await closePostgres();
});

/** Every index a plan scans, deduplicated — or a description of what it found instead. */
function indexesIn(name: string): string {
  const plan = plans.get(name) ?? '';
  const found = [
    // `using` for Index Scan / Index Only Scan, `on` for Bitmap Index Scan.
    // The first version of this helper accepted only `using`, so every bitmap
    // plan read as "no index scan" — a check that reported a defect where there
    // was none, which is the same failure class as one that reports none where
    // there is.
    ...plan.matchAll(/(?:Index Only Scan|Index Scan) using (\w+)|Bitmap Index Scan on (\w+)/g),
  ].map((match) => match[1] ?? match[2]);
  if (found.length === 0) return `no index scan (plan: ${plan.replace(/\s+/g, ' ').trim()})`;
  return [...new Set(found)].sort().join(', ');
}

describe('the album path reaches the index migration 0016 restored', () => {
  it('GET /albums/:id/tracks scans album_id directly', () => {
    // Named in the assertion so a regression reports WHICH index the planner
    // chose rather than "expected false to be true". Verified to discriminate:
    // with `tracks_album_id_idx` dropped, this reports
    // `tracks_artist_id_album_id_idx` and fails.
    expect(`album tracks: ${indexesIn('albumTracks')}`).toBe(
      'album tracks: tracks_album_id_idx'
    );
  });

  /**
   * The whole-catalogue variant is asserted differently, and deliberately more
   * weakly: "every album with at least one playable track" has to read every
   * playable track whatever index it enters through, so the planner picks among
   * several partial indexes that are all equally good for it (it chose
   * `tracks_play_count_idx` here). Naming one would be asserting an arbitrary
   * choice, which is how a test starts failing for no reason anybody can act on.
   *
   * The property that matters is that it never falls back to reading the table.
   */
  it('the album playability probe never falls back to a table scan', () => {
    expect(plans.get('albumHasPlayable')).not.toContain('Seq Scan on tracks');
    expect(`album exists: ${indexesIn('albumHasPlayable')}`).toContain('tracks_');
  });
});

describe('the artist and playlist paths reach their indexes', () => {
  /**
   * Weakened from naming `tracks_artist_id_album_id_idx` to naming the COLUMN,
   * in Task 10b, and the reason is the same one the album assertion above
   * already gives: the planner now has more than one equally good candidate.
   *
   * Migration `0017` added a plain `tracks_artist_id_idx` — the two artist-wide
   * MODERATION queries carry predicates that no partial index on the playable
   * rows can satisfy — and the planner prefers it here. Both entries read the
   * artist through an index on `artist_id`; which one wins is a cost estimate,
   * not a property of the code, so asserting the winner by name is asserting an
   * arbitrary choice that changes whenever an index is added anywhere near it.
   *
   * Measured before weakening, rather than assumed. On a 300-artist / 40,000-track
   * seed, the artist playability probe reads **913 buffers with
   * `tracks_artist_id_idx` present and 37,941 without it** — so the index the
   * moderation queries needed also made this path 41x cheaper, and the
   * assertion is being widened over an improvement, not over a regression.
   *
   * The widened matcher still discriminates: it accepts either index on
   * `artist_id` and rejects a plan that reaches neither, which is the property
   * the probe exists to hold.
   */
  it('the artist playability probe reads the artist through an index, not the table', () => {
    expect(`artist exists: ${indexesIn('artistHasPlayable')}`).toContain('tracks_artist_id');
    expect(plans.get('artistHasPlayable')).not.toContain('Seq Scan on tracks');
  });

  it('the playlist playability probe indexes both hops', () => {
    // Membership by playlist, then the track by primary key — the hop that could
    // not be indexed at all under Mongo, where `PlaylistTrack.trackId` was a
    // string and `Track._id` an ObjectId.
    const indexes = indexesIn('playlistHasPlayable');
    // TWO indexes on `playlist_tracks` lead with `playlist_id` — the unique
    // `(playlist_id, position)` and the plain `(playlist_id, track_id)` — and
    // either serves this equally. What matters is that membership is found
    // through one of them rather than by scanning, so the assertion names the
    // leading column's indexes as a set instead of picking the one the planner
    // happened to choose on the day.
    expect(
      `playlist membership: ${
        /playlist_tracks_playlist_id_(track_id_idx|position_key)/.test(indexes) ? 'indexed' : indexes
      }`
    ).toBe('playlist membership: indexed');
    expect(`playlist track lookup: ${indexes}`).toContain('tracks_pkey');
  });
});

describe('Task 10c-3: the controller list queries reach an index', () => {
  /**
   * Each names the index in the assertion so a regression reports WHICH plan the
   * planner chose. Where several partial indexes are equally good the assertion
   * names the COLUMN prefix instead, for the reason the album probe above gives:
   * asserting an arbitrary tie-break is how a test starts failing for no reason
   * anybody can act on.
   */
  const INDEXED: Readonly<Record<string, string>> = {
    // The newest-first `/api/tracks` listing: `tracks_created_at_idx` is partial
    // on the playability predicate AND ordered by exactly its sort, so the
    // planner walks it and never sorts.
    tracksListing: 'tracks_created_at_idx',
    // `genre = $1` is a real equality under the playability predicate, so the
    // partial genre index is selective and wins on its own merits.
    browseGenreTracks: 'tracks_genre_idx',
    // Point and set lookups by primary key.
    trackById: 'tracks_pkey',
    libraryTracksByIds: 'tracks_pkey',
  };

  for (const [probe, index] of Object.entries(INDEXED)) {
    it(`${probe} scans ${index}`, () => {
      expect(`${probe}: ${indexesIn(probe)}`).toContain(index);
      expect(plans.get(probe)).not.toContain('Seq Scan on tracks');
    });
  }

  /**
   * The popularity-ordered discovery shelves, asserted WEAKLY — and the reason
   * is a measurement worth recording rather than a convenience.
   *
   * Their ordering is `(cover_art_id is not null) desc, popularity desc,
   * play_count desc, created_at desc`. NO index can produce that, so the planner
   * reads the playable rows through whichever partial index is cheapest and then
   * sorts. Measured on the 4,000-row seed it chose `tracks_created_at_idx` for
   * both, not `tracks_popularity_idx` — the partial indexes all cover the same
   * rows, so the choice among them is a cost estimate, and naming one would be
   * asserting an arbitrary tie-break exactly as `albumHasPlayable` above says.
   *
   * The consequence is real and is NOT a port regression: Mongo sorted on the
   * same four keys with no compound index either, so both stores sort every
   * playable track to return a page of twenty. What changed is that it is now
   * measured. Recorded for whoever sizes the catalogue: the fix is a compound
   * index matching the shelf's own ordering, which is a schema decision and not
   * this task's to take.
   */
  for (const probe of ['browsePopularTracks', 'browseGenreCards']) {
    it(`${probe} reads through an index and sorts, never scanning the table`, () => {
      expect(`${probe}: ${indexesIn(probe)}`).toContain('tracks_');
      expect(plans.get(probe)).not.toContain('Seq Scan on tracks');
      // The sort is the point of the weakening — assert it is really there, so
      // this test stops being weak the day an index makes it unnecessary.
      expect(`${probe} sorts: ${plans.get(probe)?.includes('Sort')}`).toBe(`${probe} sorts: true`);
    });
  }

  /**
   * `GET /api/tracks` sorts NOTHING, and that is the whole point of
   * `descNullsLast`.
   *
   * A plain `desc()` emits `ORDER BY created_at DESC`, which means NULLS FIRST,
   * while every descending index in this schema is `DESC NULLS LAST` — so
   * Postgres cannot match them and puts a full sort of every playable row on top
   * of the index scan. Measured on this seed: cost 1087.00 with `desc()`, 4.34
   * with `descNullsLast()`, and the gap scales with the catalogue rather than
   * with the page.
   *
   * Asserting the absence of the Sort, not just the index name, is what makes
   * this catch a regression: the index is reached in BOTH spellings, so a probe
   * that only named it passed while the ordering was unusable.
   */
  it('the tracks listing walks the ordered index without sorting', () => {
    expect(`tracks listing sorts: ${plans.get('tracksListing')?.includes('Sort')}`).toBe(
      'tracks listing sorts: false'
    );
  });

  /**
   * Weak on purpose, and the reason is a measurement rather than a shrug.
   *
   * With `descNullsLast` this probe was observed reaching
   * `albums_release_date_idx` as a `Presorted Key` under an Incremental Sort —
   * only the `created_at` tie-break sorted, and the `EXISTS` half became a
   * Nested Loop Semi Join through `tracks_album_id_idx`. That is a real
   * improvement over the Hash Join plus full sort a bare `desc()` produced.
   *
   * It is NOT asserted, because it did not hold: the same probe chose the join
   * plan again during a full-suite run, and this database is shared with other
   * agents' suites, so `albums`' statistics and physical size move underneath
   * it. Asserting a plan that concurrent load can flip is the coin flip this
   * file's header warns about — the property that survives is that the listing
   * reaches an index on `albums` and never reads the table.
   */
  it('the album listing reaches an index and never scans the table', () => {
    expect(plans.get('albumsListing')).not.toContain('Seq Scan on albums');
    expect(`albums listing: ${indexesIn('albumsListing')}`).toContain('albums_');
  });

  /**
   * `GET /api/tracks/search` reaches `tracks_search_gin`.
   *
   * The seed gives one track in a hundred a distinctive word and the probe asks
   * for THAT. Selectivity is load-bearing, not decoration: the first version
   * searched for `'track'`, which every seeded title carries, and the planner
   * correctly preferred an ordered b-tree scan over a GIN bitmap matching 100%
   * of rows. The probe read as "the index is not used" while the query was
   * exactly right — a fixture sitting on the wrong side of the distinction, the
   * same shape as the constant `created_at` above.
   */
  /**
   * THE proof the ruling needed: the search predicate is served by
   * `tracks_search_gin` as an INDEX CONDITION, not evaluated as a filter over
   * rows some other index produced.
   *
   * `Index Cond` is the assertion, not merely the index's name in the plan: a
   * GIN index can appear in a plan for an unrelated reason, and a predicate
   * pushed into `Filter` is exactly the silent scan this whole change exists to
   * avoid.
   *
   * The probe is the predicate ALONE — no playability filter, no ORDER BY —
   * because that is what "is this query shape index-usable" means. What the
   * SHIPPED queries do with it is a cost decision, measured below.
   */
  it('the search predicate is an Index Cond on tracks_search_gin', () => {
    const plan = plans.get('searchPredicateOnly') ?? '';
    expect(`predicate: ${indexesIn('searchPredicateOnly')}`).toContain('tracks_search_gin');
    expect(`index cond: ${/Index Cond: \(search_vector @@/.test(plan)}`).toBe('index cond: true');
  });

  /**
   * The control, and the reason the assertion above is not vacuous: the SAME
   * predicate with the vector RECOMPUTED in the query instead of read from the
   * stored generated column cannot use the GIN index at all. That is the
   * mistake that costs nothing to make and nothing to notice — no error, no
   * warning, just a scan.
   */
  it('a recomputed to_tsvector reaches no text index at all', () => {
    expect(`recomputed: ${indexesIn('trackSearchRecomputed')}`).not.toContain('tracks_search_gin');
  });

  /**
   * The two SHIPPED search queries — the page and its count — reach an index
   * and never read the table, and that is all that is asserted about WHICH.
   *
   * Measured, and worth recording because it is counter-intuitive: at the 4,000
   * rows this file seeds, the planner does NOT choose the GIN index for either.
   * Both compose the search with `playableTrackFilter()`, and a bitmap over a
   * partial index covering the playable rows costs 73 against the GIN scan's
   * 153, so it takes the cheaper one and applies the tsquery as a recheck.
   *
   * That is Postgres being right, not the index being useless. The partial-index
   * cost grows with the size of the PLAYABLE CATALOGUE while the GIN cost grows
   * with the number of MATCHES, so the choice flips as the catalogue grows —
   * which is the entire reason for the ruling. Pinning the winner at this seed
   * size would pin the wrong end of that curve.
   */
  for (const probe of ['trackSearchCount', 'trackSearch']) {
    it(`${probe} reaches an index and never scans the table`, () => {
      expect(`${probe}: ${indexesIn(probe)}`).toContain('tracks_');
      expect(plans.get(probe)).not.toContain('Seq Scan on tracks');
    });
  }
});

describe('the probe can tell an index from a scan', () => {
  /**
   * If this ever stops reporting a seq scan, every assertion above has become
   * vacuous: either `set local` stopped taking effect, or `explain` stopped
   * returning a plan this file can read. A green run of the four probes above
   * means nothing without this one finding no index.
   */
  it('still reports a seq scan for a predicate no index serves', () => {
    expect(plans.get('unindexedControl')).toContain('Seq Scan on tracks');
  });

  it('the seeded catalogue actually reached the planner', () => {
    // The two vacuity risks are a seed that inserted nothing and an `ANALYZE`
    // that never ran: either leaves the planner costing against an empty table,
    // the condition that made the first version of this file flip between
    // indexes. `plans.size` and non-empty plan text see NEITHER — both hold for
    // a plan over an empty table.
    //
    // Both assertions below are read INSIDE the seeding transaction, and both
    // were mutation-tested — reporting what each actually caught, not what it
    // was hoped to:
    //
    //  - Removing the `ANALYZE` leaves `pg_stats` empty for `tracks`, failing
    //    the second assertion (and, separately, changing the playlist plan).
    //  - Emptying the track seed does not reach these assertions at all: the
    //    `playlist_tracks` foreign key refuses the dependent insert and the
    //    whole run fails loudly in `beforeAll`. The row count still earns its
    //    place for the case that fails quietly — a seed that shrinks rather
    //    than disappears.
    //
    // A planner row-estimate floor was written here first and REMOVED: it does
    // not discriminate. With the `ANALYZE` gone the estimate stayed well above
    // any useful threshold, because Postgres falls back to estimating from the
    // relation's physical size.
    expect(plans.size).toBe(16);
    expect(`tracks seeded: ${seededRowCount}`).toBe('tracks seeded: 4000');
    expect(`tracks columns in pg_stats: ${analyzedColumnCount > 0}`).toBe(
      'tracks columns in pg_stats: true'
    );
  });
});

describe('the seeding transaction left nothing behind', () => {
  it('committed no probe rows', async () => {
    const [row] = await executeRows<{ total: number }>(
      getDb(),
      sql`select (
            (select count(*) from tracks where id like ${`${MARKER}%`}) +
            (select count(*) from albums where id like ${`${MARKER}%`}) +
            (select count(*) from catalog_entities where id like ${`${MARKER}%`}) +
            (select count(*) from playlists where id like ${`${MARKER}%`}) +
            (select count(*) from playlist_tracks where id like ${`${MARKER}%`}) +
            (select count(*) from image_assets where id like ${`${MARKER}%`})
          )::int as total`
    );

    expect(row.total).toBe(0);
  });
});
