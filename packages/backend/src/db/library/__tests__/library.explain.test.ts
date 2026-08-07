/**
 * What the PLANNER does with the queries Task 11's library vertical issues.
 *
 * Third of its family, after `db/catalog/__tests__/containers.explain.test.ts`
 * and `services.explain.test.ts`, and for the same reason: on this branch a
 * definition assertion has certified a query that turned out to be a Seq Scan
 * four separate times. Reading the schema does not answer whether Postgres can
 * REACH an index for a given predicate.
 *
 * ## Seeding, rollback, and the control
 *
 * Everything runs inside ONE transaction that seeds real cardinality,
 * `ANALYZE`s, EXPLAINs and ROLLS BACK — the cleanup is the rollback rather than
 * a delete that could itself fail, and nothing is ever committed. On an empty
 * table the planner's choice is a coin flip and every assertion here would pass
 * for the wrong reason, which is what the seed floor below exists to refuse.
 *
 * `set local enable_seqscan = off` makes the planner prefer any index it CAN
 * use, so a remaining Seq Scan means no index could serve the query at all.
 * The control probe — a predicate no index covers — must still report one, or
 * "no Seq Scan" cannot be told from "stopped reading plans".
 *
 * ## What it found
 *
 * `getUserPlaylists` asks for every playlist a user OWNS or COLLABORATES ON,
 * and the obvious spelling — one `SELECT` with an `OR` of the two access paths
 * — cannot use an index for either of them. Postgres resolves the collaborator
 * half into `= ANY (hashed SubPlan)`, which is not an indexable condition, so
 * the disjunction as a whole falls to a Seq Scan even under
 * `enable_seqscan = off`. Measured against 4,000 playlists: **373 buffers and
 * 59.8 ms**, with 3,994 of 4,000 rows removed by the filter. A correlated
 * `EXISTS` is the same plan for the same reason.
 *
 * A `UNION` of two independently indexed selects, wrapped in a subquery so the
 * expression ordering is legal (`ORDER BY` after a set operation accepts only
 * result column names), is **22 buffers and 0.056 ms** — a Bitmap Index Scan on
 * `playlists_owner_oxy_user_id_created_at_idx` for the owner half and one on
 * `playlist_collaborators_oxy_user_id_idx` feeding `playlists_pkey` for the
 * other. That is the form `findPlaylistsForUser` ships, and the rejected `OR`
 * is kept below as a probe asserted to STILL scan — otherwise the improvement
 * is a claim rather than a measurement.
 *
 * ## What these probes are worth
 *
 * They are TRANSCRIPTIONS of what `db/library/*.ts` builds with drizzle, not
 * the shipped SQL, and nothing binds the two — the same caveat
 * `services.explain.test.ts` states about itself. Each proves an index EXISTS
 * AND IS REACHABLE for a predicate of that shape; none proves the module still
 * issues it. When one of those queries changes its `WHERE`, change the probe
 * with it, because no gate will say so.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb } from '../../postgres';

/** Thrown to roll the seeding transaction back once every plan is collected. */
class Rollback extends Error {}

/** Ids the seed writes, all carrying this prefix. Never committed. */
const MARKER = 'lib-explain';

const SEEDED_TRACKS = 20000;
const SEEDED_PLAYLISTS = 4000;
const SEEDED_USERS = 2000;

const SEED_AND_EXPLAIN_TIMEOUT_MS = 120_000;

/** Plan text by probe name, collected once in `beforeAll`. */
const plans = new Map<string, string>();

/** Rows actually visible inside the seeding transaction. */
let seededPlaylistCount = 0;
let seededLikeCount = 0;

const PROBES: readonly { readonly name: string; readonly sql: string }[] = [
  {
    // `db/library/membership.ts` — `listMembership('likedTracks', …)`, and the
    // identical shape for the other three junctions.
    name: 'likedTracks',
    sql: `select track_id from user_liked_tracks
          where oxy_user_id = '${MARKER}-u-7' order by created_at asc`,
  },
  {
    // `db/library/membership.ts` — `removeMembership`, the point delete.
    name: 'unlikeTrack',
    sql: `select id from user_liked_tracks
          where oxy_user_id = '${MARKER}-u-7' and track_id = '${MARKER}-t-7'`,
  },
  {
    // `db/library/playlists.ts` — `findPlaylistsForUser`. The query this file
    // was written for, and the one it changed: see the "What it found" note.
    name: 'userPlaylists',
    sql: `select * from (
            (select * from playlists where owner_oxy_user_id = '${MARKER}-u-7')
            union
            (select * from playlists
             where id in (select playlist_id from playlist_collaborators
                          where oxy_user_id = '${MARKER}-u-7'))
          ) p
          order by (p.cover_art_id is not null) desc, p.created_at desc`,
  },
  {
    // `db/library/playlists.ts` — `findCollaboratorRole`, on every edit.
    name: 'collaboratorRole',
    sql: `select role from playlist_collaborators
          where playlist_id = '${MARKER}-p-7' and oxy_user_id = '${MARKER}-u-7' limit 1`,
  },
  {
    // `db/library/playlists.ts` — `findPlaylistTracks`, in playlist order.
    name: 'playlistTracks',
    sql: `select track_id, added_at, added_by, position from playlist_tracks
          where playlist_id = '${MARKER}-p-7' order by position asc`,
  },
  {
    // `db/library/playlists.ts` — `refreshPlaylistStats`, the join that counts
    // only the PLAYABLE tracks.
    name: 'playlistStats',
    sql: `select count(*), sum(t.duration) from playlist_tracks pt
          join tracks t on t.id = pt.track_id
          where pt.playlist_id = '${MARKER}-p-7'
            and t.is_available = true and t.copyright_removed = false`,
  },
  {
    // `db/library/recentlyPlayed.ts` — `findRecentTrackIds`, the collapse to
    // most recent play per track.
    name: 'recentlyPlayed',
    sql: `select track_id from recently_played
          where oxy_user_id = '${MARKER}-u-7'
          group by track_id order by max(played_at) desc limit 20`,
  },
  {
    // `db/library/recentlyPlayed.ts` — `prunePlayHistory`'s cutoff read.
    name: 'prunePlayHistoryCutoff',
    sql: `select played_at from recently_played
          where oxy_user_id = '${MARKER}-u-7' order by played_at desc offset 100 limit 1`,
  },
  {
    /**
     * The SHAPE THAT WAS REJECTED, kept as a probe so the finding cannot be
     * undone silently. `findPlaylistsForUser` was first written as this `OR`,
     * on the reasoning that the planner would combine the two index paths
     * under a bitmap. It does not: an `= ANY (hashed SubPlan)` is not an
     * indexable condition, so the whole predicate falls to a Seq Scan.
     * Asserted below to STILL scan, which is what makes the union form's
     * measurement mean something.
     */
    name: 'userPlaylistsOr',
    sql: `select * from playlists
          where owner_oxy_user_id = '${MARKER}-u-7'
             or id in (select playlist_id from playlist_collaborators
                       where oxy_user_id = '${MARKER}-u-7')
          order by (cover_art_id is not null) desc, created_at desc`,
  },
  {
    /**
     * The control. `playlists.description` carries no index of its own — the
     * GIN index is on `search_vector`, which an equality on `description`
     * cannot use — so this MUST still report a Seq Scan under
     * `enable_seqscan = off`.
     */
    name: 'control',
    sql: `select id from playlists where description = 'nothing matches this'`,
  },
];

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function seed(tx: Tx): Promise<void> {
  await executeRows(tx, sql.raw(`
    insert into image_assets (id, s3_key, filename, content_type, byte_size, owner_type, width, height)
    select '${MARKER}-img-' || g, '${MARKER}/' || g, g || '.jpg', 'image/jpeg', 1000, 'album', 640, 640
    from generate_series(1, 500) g`));

  await executeRows(tx, sql.raw(`
    insert into catalog_entities (id, type, name, name_key, source, popularity)
    select '${MARKER}-art-' || g, 'artist', '${MARKER} artist ' || g, '${MARKER}-artist' || g, 'upload', g % 101
    from generate_series(1, 200) g`));

  /**
   * One track in 23 unavailable and one in 31 copyright-removed, coprime so all
   * four combinations occur — `playlistStats` filters on both, and a seed where
   * every track is playable cannot tell a partial index that serves the join
   * from one that cannot.
   */
  await executeRows(tx, sql.raw(`
    insert into tracks (id, title, artist_id, artist_name, duration, source, status,
                        popularity, is_available, copyright_removed)
    select '${MARKER}-t-' || g, 'Track ' || g, '${MARKER}-art-' || (1 + (g % 200)), 'Artist',
           150 + (g % 120), 'upload', 'ready', g % 101,
           case when g % 23 = 0 then false else true end,
           case when g % 31 = 0 then true else false end
    from generate_series(1, ${SEEDED_TRACKS}) g`));

  // Only one playlist in four carries cover art, so the `is not null` ordering
  // term has both sides to sort.
  await executeRows(tx, sql.raw(`
    insert into playlists (id, name, owner_oxy_user_id, owner_username, visibility, cover_art_id, followers)
    select '${MARKER}-p-' || g, 'Playlist ' || g, '${MARKER}-u-' || (1 + (g % ${SEEDED_USERS})),
           'user' || (1 + (g % ${SEEDED_USERS})),
           case when g % 3 = 0 then 'public' else 'private' end,
           case when g % 4 = 0 then '${MARKER}-img-' || (1 + (g % 500)) else null end,
           g % 97
    from generate_series(1, ${SEEDED_PLAYLISTS}) g`));

  await executeRows(tx, sql.raw(`
    insert into playlist_tracks (id, playlist_id, track_id, added_at, added_by, position)
    select '${MARKER}-pt-' || g, '${MARKER}-p-' || (1 + (g % ${SEEDED_PLAYLISTS})),
           '${MARKER}-t-' || (1 + (g % ${SEEDED_TRACKS})), now(), '${MARKER}-u-1',
           g / ${SEEDED_PLAYLISTS}
    from generate_series(0, 79999) g`));

  /**
   * The user index steps by a PRIME modulus (1999) rather than by
   * `SEEDED_USERS`, and that is load-bearing rather than arbitrary: with
   * `(g * 7) % 2000` the pair `(playlist, user)` repeats every 4,000 rows —
   * 2,000 divides both — and the seed dies on
   * `playlist_collaborators_playlist_id_oxy_user_id_key`. Measured, not
   * predicted; it is the same unique constraint the reorder path has to work
   * around.
   */
  await executeRows(tx, sql.raw(`
    insert into playlist_collaborators (id, playlist_id, oxy_user_id, username, role, added_at)
    select '${MARKER}-pc-' || g, '${MARKER}-p-' || (1 + (g % ${SEEDED_PLAYLISTS})),
           '${MARKER}-u-' || (1 + ((g * 3) % 1999)), 'user', 'editor', now()
    from generate_series(1, 6000) g`));

  // Same prime-modulus reason as the collaborators above: `(g % 2000, g %
  // 20000)` repeats every 20,000 rows and violates
  // `user_liked_tracks_oxy_user_id_track_id_key`.
  await executeRows(tx, sql.raw(`
    insert into user_liked_tracks (id, oxy_user_id, track_id, created_at)
    select '${MARKER}-lt-' || g, '${MARKER}-u-' || (1 + ((g * 3) % 1999)),
           '${MARKER}-t-' || (1 + (g % ${SEEDED_TRACKS})), now() - (g || ' seconds')::interval
    from generate_series(1, 40000) g`));

  // 250 plays for the probed user against 20 distinct tracks, so the collapse
  // has duplicates to collapse and the prune cutoff has a hundredth row.
  await executeRows(tx, sql.raw(`
    insert into recently_played (id, oxy_user_id, track_id, played_at)
    select '${MARKER}-rp-' || g, '${MARKER}-u-' || (1 + (g % ${SEEDED_USERS})),
           '${MARKER}-t-' || (1 + (g % 20)), now() - (g || ' seconds')::interval
    from generate_series(1, 60000) g`));

  await executeRows(tx, sql.raw(
    'analyze image_assets, catalog_entities, tracks, playlists, playlist_tracks, ' +
    'playlist_collaborators, user_liked_tracks, recently_played'
  ));

  const [playlists] = await executeRows<{ total: number }>(
    tx, sql.raw(`select count(*)::int as total from playlists where id like '${MARKER}-%'`));
  seededPlaylistCount = playlists?.total ?? 0;

  const [likes] = await executeRows<{ total: number }>(
    tx, sql.raw(`select count(*)::int as total from user_liked_tracks where id like '${MARKER}-%'`));
  seededLikeCount = likes?.total ?? 0;
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  await connectPostgres();

  try {
    await getDb().transaction(async (tx) => {
      await seed(tx);

      // `set local`, so the setting unwinds at rollback and cannot leak to
      // another suite sharing this pool even if a probe throws.
      await executeRows(tx, sql.raw('set local enable_seqscan = off'));

      for (const probe of PROBES) {
        const rows = await executeRows<{ 'QUERY PLAN': string }>(
          tx, sql.raw(`explain (analyze, buffers) ${probe.sql}`));
        plans.set(probe.name, rows.map((row) => row['QUERY PLAN']).join('\n'));
      }

      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}, SEED_AND_EXPLAIN_TIMEOUT_MS);

afterAll(closePostgres);

/** Index names the planner actually used, in the order they appear. */
function indexesIn(probe: string): string {
  const plan = plans.get(probe) ?? '';
  const names = [...plan.matchAll(/Index (?:Only )?Scan using (\w+)|Bitmap Index Scan on (\w+)/g)]
    .map((match) => match[1] ?? match[2]);
  return [...new Set(names)].join(', ');
}

describe('the seed is real', () => {
  it('inserted the rows the plans were measured against', () => {
    // Not decoration: on a seed that inserted nothing, every plan below is a
    // measurement of an empty table and every "no Seq Scan" assertion passes
    // for the wrong reason.
    expect(seededPlaylistCount).toBe(SEEDED_PLAYLISTS);
    expect(seededLikeCount).toBe(40000);
  });

  it('the control still reports a table scan under enable_seqscan = off', () => {
    expect(plans.get('control')).toContain('Seq Scan on playlists');
  });
});

describe('the membership reads reach an index', () => {
  it('a user\'s liked tracks are read through the unique index', () => {
    expect(plans.get('likedTracks')).not.toContain('Seq Scan on user_liked_tracks');
    expect(`liked tracks: ${indexesIn('likedTracks')}`).toBe(
      'liked tracks: user_liked_tracks_oxy_user_id_track_id_key'
    );
  });

  it('unliking one track is a point lookup, not a scan of the user\'s likes', () => {
    expect(plans.get('unlikeTrack')).not.toContain('Seq Scan on user_liked_tracks');
    expect(`unlike: ${indexesIn('unlikeTrack')}`).toBe(
      'unlike: user_liked_tracks_oxy_user_id_track_id_key'
    );
  });
});

describe('the playlist reads reach an index', () => {
  /**
   * Both index names are asserted, so a regression says WHICH half stopped
   * being reachable rather than only that the plan changed.
   */
  it('a user\'s own and collaborated playlists both come from an index', () => {
    expect(plans.get('userPlaylists')).not.toContain('Seq Scan on playlists');
    expect(plans.get('userPlaylists')).not.toContain('Seq Scan on playlist_collaborators');
    const used = indexesIn('userPlaylists');
    expect(`owner half: ${used.includes('playlists_owner_oxy_user_id_created_at_idx')}`).toBe(
      'owner half: true'
    );
    expect(
      `collaborator half: ${used.includes('playlist_collaborators_oxy_user_id_idx')}`
    ).toBe('collaborator half: true');
  });

  /**
   * The counterpart measurement. Without this, "the union form uses indexes"
   * could equally mean the planner would have used them for any spelling, and
   * the rewrite would be unjustified.
   */
  it('the OR spelling this replaced still cannot use either index', () => {
    expect(plans.get('userPlaylistsOr')).toContain('Seq Scan on playlists');
  });

  it('the edit-permission check is a point lookup on the unique index', () => {
    expect(plans.get('collaboratorRole')).not.toContain('Seq Scan on playlist_collaborators');
    expect(`collaborator role: ${indexesIn('collaboratorRole')}`).toBe(
      'collaborator role: playlist_collaborators_playlist_id_oxy_user_id_key'
    );
  });

  it('a playlist\'s tracks are read in order without sorting the table', () => {
    expect(plans.get('playlistTracks')).not.toContain('Seq Scan on playlist_tracks');
    expect(`playlist tracks: ${indexesIn('playlistTracks')}`).toContain('playlist_tracks_');
  });

  it('the stats recount joins through indexes on both sides', () => {
    expect(plans.get('playlistStats')).not.toContain('Seq Scan on playlist_tracks');
    expect(plans.get('playlistStats')).not.toContain('Seq Scan on tracks');
  });
});

describe('the play log reads reach an index', () => {
  it('collapsing plays to distinct tracks does not scan the log', () => {
    expect(plans.get('recentlyPlayed')).not.toContain('Seq Scan on recently_played');
    expect(`recently played: ${indexesIn('recentlyPlayed')}`).toBe(
      'recently played: recently_played_oxy_user_id_played_at_idx'
    );
  });

  it('the retention cutoff is read off the same ordered index', () => {
    expect(plans.get('prunePlayHistoryCutoff')).not.toContain('Seq Scan on recently_played');
    expect(`prune cutoff: ${indexesIn('prunePlayHistoryCutoff')}`).toBe(
      'prune cutoff: recently_played_oxy_user_id_played_at_idx'
    );
  });
});
