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
import { and, asc, desc, eq, sql, type SQLWrapper } from 'drizzle-orm';
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
} from '../containers';

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
                            popularity, is_available, copyright_removed, genre, mood)
        select ${MARKER} || '-t-' || g, 'Track ' || g,
               ${MARKER} || '-art-' || (1 + (g % 200)), 'Artist',
               ${MARKER} || '-alb-' || (1 + (g % 400)), 200, 'upload', 'ready', g % 101,
               case when (1 + (g % 400)) % 7 = 0 then false else true end,
               false,
               (array['rock','pop','jazz','ambient','hiphop'])[1 + (g % 5)],
               (array['chill','energetic','sad','happy'])[1 + (g % 4)]
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
  it('the artist playability probe uses the compound index on its leading column', () => {
    expect(`artist exists: ${indexesIn('artistHasPlayable')}`).toContain(
      'tracks_artist_id_album_id_idx'
    );
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
    expect(plans.size).toBe(5);
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
