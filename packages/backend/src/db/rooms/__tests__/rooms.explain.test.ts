/**
 * What the PLANNER does with the queries Task 14's rooms-and-live vertical
 * issues.
 *
 * Fifth of its family, after `db/catalog/__tests__/containers.explain.test.ts`,
 * `services.explain.test.ts`, `db/library/__tests__/library.explain.test.ts`
 * and `db/creators/__tests__/creators.explain.test.ts`, and for the same reason:
 * on this branch a definition assertion has certified a query that turned out to
 * be a Seq Scan five separate times now. Reading the schema does not answer
 * whether Postgres can REACH an index for a given predicate.
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
 * **The houses listing was a full table scan, and the index built for it was
 * unreachable.** `listHouses` first transcribed Mongo's `$nin` directly, and
 * `visibility_discovery NOT IN ('unlisted', 'hidden')` renders as `<> ALL (…)`,
 * which no btree can serve — measured under `enable_seqscan = off`, it
 * sequential-scans `houses` and top-N sorts, on the most-requested listing in
 * this vertical. Asking the same question as `IN (…)` over the discoverable
 * complement is an Index Scan with no sort. `housesListingNotIn` below keeps the
 * rejected shape and is asserted to STILL scan.
 *
 * **Every `createdAt` listing in this vertical shipped with drizzle's `desc()`
 * and had to be changed to `descNullsLast`.** All six descending indexes here
 * are `DESC NULLS LAST` (`"created_at" DESC NULLS LAST` in `0011`), and `desc()`
 * emits plain `DESC`, i.e. NULLS FIRST. `created_at` is NOT NULL, which makes
 * the two semantically identical and reads like an exemption; it is not one,
 * because Postgres matches an ordering to an index SYNTACTICALLY and does not
 * reconcile the nulls placement using the constraint. Same defect
 * `creators.explain.test.ts` found on the locker listing, present on all four
 * listings here — rooms, houses, series and recordings — before this suite
 * measured them. `roomsSingleStatusNullsFirst` keeps the rejected shape.
 *
 * That is also why the assertions here check for the absence of a **Sort node**
 * rather than only naming the index: the index NAME is identical either way.
 *
 * **Only the SINGLE-status room listing can take its ordering from an index.**
 * Every listing index is `(…, status, created_at DESC NULLS LAST)`, so
 * `created_at` is ordered only within one status; the default listing's
 * `status in ('live', 'scheduled')` spans two, and no index scan can produce one
 * ordered stream across both. Measured: `roomsDefault` sorts 18,182 rows to
 * return 21. Mongo had the identical shape against `{ status: 1, createdAt: -1 }`,
 * so this is carried forward rather than introduced — but it is why the
 * `descNullsLast` finding above is demonstrated on the single-status probe,
 * which is the only one where the two spellings differ.
 *
 * **The live-badge feed needed `archived = false` added to it, and that is a
 * behaviour change rather than a tuning one.** `rooms_status_created_at_idx` is
 * partial on `archived = false`, so Mongo's `find({ status: 'live' })` — which
 * carries no `archived` clause — cannot use it and scans the table.
 * `liveUsersUnfiltered` below is that query, asserted to STILL scan.
 * `archived` is also the moderation restriction lever for a room, so the
 * unfiltered query kept emitting a live badge for a room a moderator had
 * restricted; the ported `findLiveRoomBroadcasters` carries the predicate.
 *
 * **The five constraint-support indexes are reached by the referential-integrity
 * queries, not just declared.** `rooms_house_id_idx`, `series_house_id_idx`,
 * `rooms_series_id_idx`, `series_episodes_room_id_idx` and
 * `recordings_room_id_status_created_at_idx` each exist for an `ON DELETE SET
 * NULL` rather than for any application query, and each is probed here with the
 * exact `select 1 from only <table> x where <col> = $1 for key share of x` shape
 * Postgres runs.
 *
 * **Two probes deliberately do NOT assert the absence of a sort.**
 * `seriesForHouse` and `roomQueue` each have two indexes that can answer them,
 * and at the seeded cardinality the planner chose a bitmap plus a quicksort over
 * an ordered index scan. The ordering keys it produced match the indexes, so
 * these are costing decisions rather than pathkey mismatches; asserting no sort
 * would pin a cost estimate that moves with the statistics.
 *
 * ## The limit this suite shares with its four siblings
 *
 * **Every probe below is hand-transcribed SQL.** It imports nothing from
 * `db/rooms/*.ts`, so a regression in a SHIPPED query leaves this suite green —
 * measured on the sibling suite, where reverting `listOwnedUploads` to plain
 * `desc()` left it at 25 pass / 0 fail. Binding the probes to the real builders
 * (`.toSQL()` on what the modules actually construct) is the shape that would
 * close it, and it is a change to all five suites in this family rather than to
 * this one. Until then, read every assertion here as being about an INDEX, never
 * about a call site.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { closePostgres, getDb } from '../../postgres';
import { connectUnmanagedDb } from '../../../test/postgres';
import { descNullsLast } from '../../catalog/containers';
import { houseListingConditions } from '../houses';
import { houses } from '../../schema/rooms';

/** Thrown to roll the seeding transaction back once every plan is collected. */
class Rollback extends Error {}

/** Ids the seed writes, all carrying this prefix. Never committed. */
const MARKER = 'rooms-explain';

const SEEDED_HOUSES = 3000;
const SEEDED_MEMBERS = 20000;
const SEEDED_ROOMS = 30000;
const SEEDED_SERIES = 4000;
const SEEDED_EPISODES = 12000;
const SEEDED_RECORDINGS = 20000;
const SEEDED_QUEUE_ITEMS = 15000;
const SEEDED_PREFERENCES = 8000;

const SEED_AND_EXPLAIN_TIMEOUT_MS = 120_000;

/**
 * The authenticated listing's SQL, rendered from the SHIPPED predicate.
 *
 * `toSQL()` gives the query drizzle would send, with `$1`-style placeholders;
 * the parameters are inlined here because `EXPLAIN` is issued through
 * `sql.raw`. Every value substituted is a marker string this file generated, so
 * nothing user-supplied reaches the statement.
 *
 * The member id list is the size the seed gives the probed user, which is what
 * makes the plan meaningful — a two-element list would let the planner pick
 * differently from a 2,800-element one.
 */
function authedListingSql(): string {
  const query = getDb()
    .select({ id: houses.id, name: houses.name })
    .from(houses)
    .where(houseListingConditions({ memberHouseIds: seededMemberHouseIds }))
    .orderBy(descNullsLast(houses.createdAt))
    .limit(21)
    .toSQL();

  // One replacement per `$n`, and every parameter is a scalar: drizzle renders
  // `inArray` as `id in ($2, $3, … $N)`, never `= ANY($2::text[])`, so there is
  // no array case to handle. An earlier version carried a branch for one; it was
  // dead, and a dead branch here reads as evidence that the other form occurs.
  return query.sql.replace(/\$(\d+)/g, (_match, index) =>
    `'${String(query.params[Number(index) - 1])}'`
  );
}

/** Plan text by probe name, collected once in `beforeAll`. */
const plans = new Map<string, string>();

/** House ids the probed member belongs to, filled by the seed. */
let seededMemberHouseIds: string[] = [];

let seededRoomCount = 0;
let seededHouseCount = 0;
let seededRecordingCount = 0;

/**
 * `sql` is a thunk where the statement has to be BUILT rather than written —
 * `authedListingSql` calls `getDb()` and reads the seeded membership, neither of
 * which exists at module load. Resolved in `beforeAll`, after the seed.
 */
const PROBES: readonly { readonly name: string; readonly sql: string | (() => string) }[] = [
  // ── rooms ───────────────────────────────────────────────────────────────
  {
    // `db/rooms/rooms.ts` — `listRooms` with no filters, `GET /api/rooms`.
    name: 'roomsDefault',
    sql: `select id, title from rooms
          where archived = false and status in ('live', 'scheduled')
          order by created_at desc nulls last limit 21`,
  },
  {
    // `listRooms` with `?houseId=`, and `GET /api/houses/:id/rooms`.
    name: 'roomsByHouse',
    sql: `select id, title from rooms
          where archived = false and status in ('live', 'scheduled')
            and house_id = '${MARKER}-h-7'
          order by created_at desc nulls last limit 21`,
  },
  {
    // `listRooms` with `?host=`.
    name: 'roomsByHost',
    sql: `select id, title from rooms
          where archived = false and status in ('live', 'scheduled')
            and host = '${MARKER}-u-7'
          order by created_at desc nulls last limit 21`,
  },
  {
    // `listRooms` with `?type=`.
    name: 'roomsByType',
    sql: `select id, title from rooms
          where archived = false and status in ('live', 'scheduled') and type = 'broadcast'
          order by created_at desc nulls last limit 21`,
  },
  {
    // `listRooms` with `?ownerType=`, e.g. every agora broadcast.
    name: 'roomsByOwnerType',
    sql: `select id, title from rooms
          where archived = false and status in ('live', 'scheduled')
            and owner_type = 'agora' and type = 'broadcast'
          order by created_at desc nulls last limit 21`,
  },
  {
    // `listRooms` with `?status=live` — ONE status value, which is the only
    // shape from which the `(status, created_at)` index can supply the ordering
    // outright. The default listing's two-value `IN` cannot; see the assertions.
    name: 'roomsSingleStatus',
    sql: `select id, title from rooms
          where archived = false and status = 'live'
          order by created_at desc nulls last limit 21`,
  },
  {
    // `findLiveRoomBroadcasters` — `GET /api/rooms/live-users`, WITH the
    // `archived` predicate this port added.
    name: 'liveUsers',
    sql: `select id, host, speakers from rooms where status = 'live' and archived = false`,
  },
  {
    // `findRoomByIngressId` — every LiveKit webhook delivery.
    name: 'roomByIngress',
    sql: `select id from rooms where active_ingress_id = '${MARKER}-ing-700' limit 1`,
  },
  {
    // `findRoomQueue` — the up-next queue, in queue order.
    name: 'roomQueue',
    sql: `select kind, episode_id, track_id from room_media_queue_items
          where room_id = '${MARKER}-r-7' order by position asc`,
  },

  // ── houses ──────────────────────────────────────────────────────────────
  {
    // `db/rooms/houses.ts` — `listHouses`, `GET /api/houses` for an anonymous
    // caller (no membership arm). `IN` over the discoverable complement, which
    // is what that function was changed to emit — see `housesListingNotIn`.
    name: 'housesListing',
    sql: `select id, name from houses
          where visibility_discovery in ('listed')
          order by created_at desc nulls last limit 21`,
  },
  {
    // `listHouses` with `?search=` — the `tsvector` replacing Mongo's `$text`.
    name: 'housesSearch',
    sql: `select id, name from houses
          where visibility_discovery in ('listed')
            and search_vector @@ plainto_tsquery('english', 'jazz')
          order by created_at desc nulls last limit 21`,
  },
  {
    /**
     * **The arm that actually runs.** `GET /api/houses` is mounted behind
     * `oxy.auth()` (`server.ts:353`, required), so a viewer is always resolved
     * and `listHouses` always takes the membership arm. `housesListing` above
     * probes the anonymous arm, which no request reaches.
     *
     * Unlike every other probe in this file, this one's WHERE clause is BUILT BY
     * THE SHIPPED CODE — `houseListingConditions` — rather than transcribed. The
     * Seq Scan this replaced survived precisely because a hand-written probe
     * described a different query from the one that ran.
     */
    name: 'housesListingAuthed',
    sql: authedListingSql,
  },
  {
    /**
     * The membership arm as a correlated `EXISTS`, which is what `listHouses`
     * first shipped and the direct transcription of Mongo's
     * `'members.userId': userId`.
     *
     * An `OR` between a column predicate and a correlated subquery gives the
     * planner nothing to combine, so it is a **Seq Scan** even under
     * `enable_seqscan = off` — asserted below. Kept so the finding cannot be
     * undone quietly.
     */
    name: 'housesListingExists',
    sql: `select id, name from houses
          where (visibility_discovery in ('listed')
                 or exists (select 1 from house_members
                            where house_members.house_id = houses.id
                              and house_members.oxy_user_id = '${MARKER}-u-7'))
          order by created_at desc nulls last limit 21`,
  },
  {
    // The search predicate ALONE — the shape that proves `houses_search_gin` is
    // reachable at all, independently of what the planner prefers once an
    // ordered index and a `LIMIT` are also in play.
    name: 'housesSearchOnly',
    sql: `select id, name from houses
          where search_vector @@ plainto_tsquery('english', 'jazz')`,
  },
  {
    // `houseIdsWithRoomsHiddenFrom` — runs on EVERY global room listing, which
    // makes it the hottest query in this vertical.
    name: 'hiddenHouseIds',
    sql: `select id from houses
          where (visibility_discovery = 'hidden' or visibility_rooms = 'members')
            and not exists (select 1 from house_members
                            where house_members.house_id = houses.id
                              and house_members.oxy_user_id = '${MARKER}-u-7')`,
  },
  {
    // `findHouseMembers` — the roster read behind every permission check.
    name: 'houseRoster',
    sql: `select oxy_user_id, role from house_members
          where house_id = '${MARKER}-h-7' order by joined_at, id`,
  },
  {
    // `findMembersByHouseIds` — one batched roster read for a listing page.
    name: 'rostersByHouseIds',
    sql: `select house_id, oxy_user_id from house_members
          where house_id in ('${MARKER}-h-7', '${MARKER}-h-8', '${MARKER}-h-9')
          order by joined_at, id`,
  },
  {
    // The REVERSE direction — "every house this user belongs to" — which
    // `listHouses`' membership arm and `hiddenHouseIds`' `not exists` both need.
    // `house_members_oxy_user_id_idx` exists for exactly this, and the unique
    // index leading with `house_id` cannot serve it.
    name: 'housesForMember',
    sql: `select house_id from house_members where oxy_user_id = '${MARKER}-u-7'`,
  },

  // ── series ──────────────────────────────────────────────────────────────
  {
    // `db/rooms/series.ts` — `listActiveSeriesForHouse`, the only series
    // listing there is.
    name: 'seriesForHouse',
    sql: `select id, title from series
          where house_id = '${MARKER}-h-7' and is_active = true
          order by created_at desc nulls last`,
  },
  {
    // `findSeriesEpisodes` — the episode log, in queue order.
    name: 'seriesEpisodes',
    sql: `select room_id, episode_number from series_episodes
          where series_id = '${MARKER}-s-7' order by position asc`,
  },

  // ── recordings ──────────────────────────────────────────────────────────
  {
    // `db/rooms/recordings.ts` — `listPublicRecordings('recent')`.
    name: 'recordingsRecent',
    sql: `select id, room_title from recordings
          where status = 'ready' and access = 'public'
          order by created_at desc nulls last limit 10`,
  },
  {
    // `listRoomRecordings` for a MANAGER — room + ready, newest first.
    name: 'roomRecordings',
    sql: `select id from recordings
          where room_id = '${MARKER}-r-7' and status = 'ready'
          order by created_at desc nulls last limit 21`,
  },
  {
    // `listRoomRecordings` for a PARTICIPANT — the containment half, which is
    // what `recordings_participant_ids_gin` exists for.
    name: 'participantRecordings',
    sql: `select id from recordings
          where participant_ids @> array['${MARKER}-u-7']::text[]`,
  },
  {
    // `findRecordingByEgressId` — the egress webhook's only lookup key.
    name: 'recordingByEgress',
    sql: `select id from recordings where egress_id = '${MARKER}-eg-700' limit 1`,
  },
  {
    // `findTopHosts` — `status = 'ready'` ALONE, grouped by host. The partial
    // public index cannot serve it (it is narrower), which is why
    // `recordings_ready_host_idx` exists.
    name: 'topHosts',
    sql: `select host, count(*)::int as room_count,
                 coalesce(sum(cardinality(participant_ids)), 0)::int as total_listeners
          from recordings where status = 'ready'
          group by host order by 3 desc limit 10`,
  },
  {
    // `roomHasRecording` — the moderation snapshot's existence probe.
    name: 'roomHasRecording',
    sql: `select id from recordings where room_id = '${MARKER}-r-7' limit 1`,
  },

  // ── preferences ─────────────────────────────────────────────────────────
  {
    // `findLiveVisibilities` — the batched read behind the live-badge feed.
    name: 'livePreferences',
    sql: `select oxy_user_id, live_visibility from room_user_preferences
          where oxy_user_id in ('${MARKER}-u-7', '${MARKER}-u-8', '${MARKER}-u-9')`,
  },

  // ── the four constraint-support indexes ─────────────────────────────────
  /**
   * Each of these is the query POSTGRES runs for an `ON DELETE SET NULL`, not a
   * query the application issues. They are the reason four indexes in
   * `schema/rooms.ts` are documented as MUST STAY NON-PARTIAL: the RI query
   * carries no `archived`/`is_active` clause and has to find every referencing
   * row, so a partial index cannot serve it and the delete degrades to a
   * sequential scan of the whole child table.
   */
  {
    name: 'riRoomsByHouse',
    sql: `select 1 from only rooms x where house_id = '${MARKER}-h-7' for key share of x`,
  },
  {
    name: 'riSeriesByHouse',
    sql: `select 1 from only series x where house_id = '${MARKER}-h-7' for key share of x`,
  },
  {
    name: 'riRoomsBySeries',
    sql: `select 1 from only rooms x where series_id = '${MARKER}-s-7' for key share of x`,
  },
  {
    name: 'riEpisodesByRoom',
    sql: `select 1 from only series_episodes x where room_id = '${MARKER}-r-7' for key share of x`,
  },
  {
    name: 'riRecordingsByRoom',
    sql: `select 1 from only recordings x where room_id = '${MARKER}-r-7' for key share of x`,
  },

  // ── the two REJECTED shapes, kept so the findings cannot be undone quietly ─
  {
    /**
     * `listRooms(?status=live)` as it would be with drizzle's `desc()`.
     *
     * Every descending index in this schema is `DESC NULLS LAST`; `desc()`
     * emits `DESC` (NULLS FIRST). Postgres matches an ordering to an index
     * syntactically, so the pathkeys never match: `roomsSingleStatus` above is
     * an Index Scan that stops at 21 rows, and this one bitmap-scans all 9,091
     * live rooms and top-N sorts them. `created_at` being NOT NULL makes the
     * two semantically identical and changes nothing about the plan.
     *
     * The SINGLE-status form is deliberately the one kept here. Paired with the
     * two-value default it would prove nothing — that shape sorts either way —
     * so a probe built on it could not tell the fix from the defect.
     *
     * Still NOT a guard against a revert, since this is a transcription and not
     * the shipped query. See the file header.
     */
    name: 'roomsSingleStatusNullsFirst',
    sql: `select id, title from rooms
          where archived = false and status = 'live'
          order by created_at desc limit 21`,
  },
  {
    /**
     * `listHouses` as it was first written — `NOT IN` over the two hiding
     * levels, the direct transcription of Mongo's `$nin`.
     *
     * `<> ALL (…)` is not a btree-indexable condition, so this cannot use
     * `houses_visibility_discovery_created_at_idx` AT ALL and sequential-scans
     * `houses` under `enable_seqscan = off`. Asserted below to STILL scan, which
     * is what makes the shipped `IN` form's Index Scan mean something.
     */
    name: 'housesListingNotIn',
    sql: `select id, name from houses
          where visibility_discovery not in ('unlisted', 'hidden')
          order by created_at desc nulls last limit 21`,
  },
  {
    /**
     * The live-badge feed as MONGO issued it — `status = 'live'` with no
     * `archived` clause.
     *
     * `rooms_status_created_at_idx` is partial on `archived = false`, and a
     * partial index is unusable unless the query's predicate IMPLIES the index
     * predicate. This one carries no `archived` clause at all, so it scans —
     * asserted below, which is the proof that the PREDICATE and not the column
     * list is what excluded it.
     */
    name: 'liveUsersUnfiltered',
    sql: `select id, host, speakers from rooms where status = 'live'`,
  },
  {
    /**
     * The control. `rooms.stream_image` carries no index of any kind, so this
     * MUST still report a Seq Scan under `enable_seqscan = off`.
     */
    name: 'control',
    sql: `select id from rooms where stream_image = 'nothing-matches-this'`,
  },
];

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function seed(tx: Tx): Promise<void> {
  /**
   * Houses across all three discovery levels and both room-access levels, so
   * `hiddenHouseIds` has a real mix to narrow rather than one value repeated.
   * One in nine is hidden and one in five is members-only.
   */
  await executeRows(tx, sql.raw(`
    insert into houses (id, name, description, created_by,
                        visibility_discovery, visibility_rooms, visibility_join, created_at)
    select '${MARKER}-h-' || g,
           'House ' || g || case when g % 11 = 0 then ' jazz' else '' end,
           'A description for house ' || g,
           '${MARKER}-u-' || (1 + (g % 1500)),
           case when g % 9 = 0 then 'hidden' when g % 4 = 0 then 'unlisted' else 'listed' end,
           case when g % 5 = 0 then 'members' else 'anyone' end,
           case when g % 3 = 0 then 'anyone' else 'invite' end,
           now() - (g || ' seconds')::interval
    from generate_series(1, ${SEEDED_HOUSES}) g`));

  /**
   * The roster. ONE IN SEVEN membership rows goes to the probed user, for the
   * reason `creators.explain.test.ts` recorded on its own locker: spread evenly
   * across 1,500 users the probed member belonged to a dozen houses, and at that
   * size the planner rationally preferred a bitmap plus a sort over the ordered
   * index — so the probe measured a roster nobody has.
   *
   * `(house_id, oxy_user_id)` is UNIQUE, so the generator pairs each house with
   * users stepping by a modulus coprime to the house count; the probed user gets
   * a distinct house each time rather than colliding on one.
   */
  await executeRows(tx, sql.raw(`
    insert into house_members (id, house_id, oxy_user_id, role, joined_at)
    select '${MARKER}-hm-' || g,
           '${MARKER}-h-' || (1 + (g % ${SEEDED_HOUSES})),
           case when g % 7 = 0 then '${MARKER}-u-7'
                else '${MARKER}-u-' || (1 + ((g * 3) % 1499)) end,
           case when g % 13 = 0 then 'owner' when g % 5 = 0 then 'admin' else 'member' end,
           now() - (g || ' seconds')::interval
    from generate_series(1, ${SEEDED_MEMBERS}) g
    on conflict do nothing`));

  await executeRows(tx, sql.raw(`
    insert into series (id, title, house_id, created_by, recurrence_type, recurrence_time,
                        recurrence_timezone, room_template_title_pattern, room_template_type,
                        next_episode_number, is_active, created_at)
    select '${MARKER}-s-' || g, 'Series ' || g,
           case when g % 7 = 0 then '${MARKER}-h-7'
                else '${MARKER}-h-' || (1 + (g % ${SEEDED_HOUSES})) end,
           '${MARKER}-u-' || (1 + (g % 1500)),
           case when g % 4 = 0 then 'daily' when g % 4 = 1 then 'weekly'
                when g % 4 = 2 then 'biweekly' else 'monthly' end,
           '18:00', 'UTC', 'Episode {n}', 'talk', 1,
           case when g % 6 = 0 then false else true end,
           now() - (g || ' seconds')::interval
    from generate_series(1, ${SEEDED_SERIES}) g`));

  /**
   * The rooms, with every dimension the probes narrow on actually varying.
   *
   * One in eleven is archived (the moderation lever), status is spread across
   * all three values, one in seven is agora-owned, one in five is a broadcast,
   * and one in seven belongs to the probed house AND the probed host — the same
   * one-in-seven concentration the roster uses, and for the same reason.
   * `active_ingress_id` is set on one room in 40, matching the real shape the
   * partial `rooms_active_ingress_id_idx` was built for.
   */
  await executeRows(tx, sql.raw(`
    insert into rooms (id, title, owner_type, host, house_id, type, broadcast_kind, status,
                       speaker_permission, participants, speakers, max_participants,
                       tags, archived, series_id, active_ingress_id, stream_image, created_at)
    select '${MARKER}-r-' || g,
           'Room ' || g,
           case when g % 7 = 0 then 'agora' when g % 3 = 0 then 'house' else 'profile' end,
           case when g % 7 = 0 then '${MARKER}-u-7'
                else '${MARKER}-u-' || (1 + (g % 1500)) end,
           case when g % 3 = 0 then
                  (case when g % 7 = 0 then '${MARKER}-h-7'
                        else '${MARKER}-h-' || (1 + (g % ${SEEDED_HOUSES})) end)
                else null end,
           case when g % 5 = 0 then 'broadcast' when g % 5 = 1 then 'stage' else 'talk' end,
           case when g % 5 = 0 then 'user' else null end,
           case when g % 3 = 0 then 'live' when g % 3 = 1 then 'scheduled' else 'ended' end,
           'invited',
           array[]::text[], array['${MARKER}-u-' || (1 + (g % 1500))]::text[], 100,
           array['jazz']::text[],
           case when g % 11 = 0 then true else false end,
           case when g % 23 = 0 then '${MARKER}-s-' || (1 + (g % ${SEEDED_SERIES})) else null end,
           case when g % 40 = 0 then '${MARKER}-ing-' || g else null end,
           'https://cdn.example/img-' || g || '.jpg',
           now() - (g || ' seconds')::interval
    from generate_series(1, ${SEEDED_ROOMS}) g`));

  await executeRows(tx, sql.raw(`
    insert into series_episodes (id, series_id, position, room_id, scheduled_start, episode_number)
    select '${MARKER}-se-' || g,
           case when g % 7 = 0 then '${MARKER}-s-7'
                else '${MARKER}-s-' || (1 + (g % ${SEEDED_SERIES})) end,
           g,
           case when g % 7 = 0 then '${MARKER}-r-7'
                else '${MARKER}-r-' || (1 + (g % ${SEEDED_ROOMS})) end,
           now() - (g || ' seconds')::interval, 1 + (g % 50)
    from generate_series(1, ${SEEDED_EPISODES}) g`));

  /**
   * Recordings. Status varies across all five values so
   * `recordings_ready_host_idx`'s partial predicate is a real narrowing, and
   * one in six is participants-only so the GIN containment probe is not the
   * whole table. `participant_ids` puts the probed user on one row in seven.
   */
  await executeRows(tx, sql.raw(`
    insert into recordings (id, room_id, room_title, host, status, egress_id, object_key,
                            started_at, access, participant_ids, expires_at, created_at)
    select '${MARKER}-rec-' || g,
           case when g % 7 = 0 then '${MARKER}-r-7'
                else '${MARKER}-r-' || (1 + (g % ${SEEDED_ROOMS})) end,
           'Room ' || g,
           case when g % 7 = 0 then '${MARKER}-u-7'
                else '${MARKER}-u-' || (1 + (g % 1500)) end,
           case when g % 17 = 0 then 'failed' when g % 13 = 0 then 'processing'
                when g % 29 = 0 then 'deleted' when g % 31 = 0 then 'recording'
                else 'ready' end,
           '${MARKER}-eg-' || g,
           'recordings/' || g || '.ogg',
           now() - (g || ' seconds')::interval,
           case when g % 6 = 0 then 'participants' else 'public' end,
           case when g % 7 = 0
                then array['${MARKER}-u-7', '${MARKER}-u-' || (1 + (g % 1500))]::text[]
                else array['${MARKER}-u-' || (1 + (g % 1500))]::text[] end,
           now() + interval '180 days',
           now() - (g || ' seconds')::interval
    from generate_series(1, ${SEEDED_RECORDINGS}) g`));

  await executeRows(tx, sql.raw(`
    insert into room_media_queue_items (id, room_id, position, kind, episode_id, track_id)
    select '${MARKER}-q-' || g,
           case when g % 7 = 0 then '${MARKER}-r-7'
                else '${MARKER}-r-' || (1 + (g % ${SEEDED_ROOMS})) end,
           g,
           case when g % 2 = 0 then 'podcast' else 'track' end,
           case when g % 2 = 0 then '${MARKER}-ep-' || g else null end,
           case when g % 2 = 0 then null else '${MARKER}-t-' || g end
    from generate_series(1, ${SEEDED_QUEUE_ITEMS}) g`));

  await executeRows(tx, sql.raw(`
    insert into room_user_preferences (id, oxy_user_id, live_visibility)
    select '${MARKER}-pref-' || g, '${MARKER}-u-' || g,
           case when g % 3 = 0 then 'speaking' else 'active' end
    from generate_series(1, ${SEEDED_PREFERENCES}) g`));

  await executeRows(tx, sql.raw(
    'analyze houses, house_members, series, series_episodes, rooms, ' +
    'room_media_queue_items, recordings, room_user_preferences'
  ));

  const [rooms] = await executeRows<{ total: number }>(
    tx, sql.raw(`select count(*)::int as total from rooms where id like '${MARKER}-%'`));
  seededRoomCount = rooms?.total ?? 0;

  const [houses] = await executeRows<{ total: number }>(
    tx, sql.raw(`select count(*)::int as total from houses where id like '${MARKER}-%'`));
  seededHouseCount = houses?.total ?? 0;

  const [recordings] = await executeRows<{ total: number }>(
    tx, sql.raw(`select count(*)::int as total from recordings where id like '${MARKER}-%'`));
  seededRecordingCount = recordings?.total ?? 0;

  // Read back rather than reconstructed: the roster insert carries
  // `on conflict do nothing`, so the probed member's real house set is whatever
  // survived the unique constraint.
  const memberRows = await executeRows<{ house_id: string }>(
    tx, sql.raw(`select house_id from house_members where oxy_user_id = '${MARKER}-u-7'`));
  seededMemberHouseIds = memberRows.map((row) => row.house_id);
}

beforeAll(async () => {
  await connectUnmanagedDb();

  try {
    await getDb().transaction(async (tx) => {
      await seed(tx);

      // `set local`, so the setting unwinds at rollback and cannot leak to
      // another suite sharing this pool even if a probe throws.
      await executeRows(tx, sql.raw('set local enable_seqscan = off'));

      for (const probe of PROBES) {
        const statement = typeof probe.sql === 'function' ? probe.sql() : probe.sql;
        const rows = await executeRows<{ 'QUERY PLAN': string }>(
          tx, sql.raw(`explain (analyze, buffers) ${statement}`));
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
function indexesIn(probe: string): string[] {
  const plan = plans.get(probe) ?? '';
  const names = [...plan.matchAll(/Index (?:Only )?Scan using (\w+)|Bitmap Index Scan on (\w+)/g)]
    .map((match) => match[1] ?? match[2]);
  return [...new Set(names)];
}

/** Assert one probe reached an index at all, naming the table it must not scan. */
function expectIndexed(probe: string, table: string): void {
  expect(`${probe}: ${plans.get(probe)?.includes(`Seq Scan on ${table}`) ?? 'NO PLAN'}`).toBe(
    `${probe}: false`
  );
}

/**
 * Assert the probe used ONE OF the named indexes, and used something.
 *
 * A set rather than a single name wherever the planner has a free choice:
 * `rooms` carries five listing indexes all partial on `archived = false`, and
 * for a predicate constraining only `status` several of them are a correct
 * answer — Postgres picks by cost, which moves with the statistics. Asserting
 * one name would be asserting a costing decision; asserting membership is the
 * property the schema promises.
 */
function expectIndexAmong(probe: string, allowed: readonly string[]): void {
  const used = indexesIn(probe);
  const offenders = used.filter((name) => !allowed.includes(name));
  expect(`${probe} used unexpected: ${offenders.join(', ') || 'none'}`).toBe(
    `${probe} used unexpected: none`
  );
  // Vacuity floor: an empty list satisfies the filter above trivially.
  expect(`${probe} used any index: ${used.length > 0}`).toBe(`${probe} used any index: true`);
}

/**
 * Assert the ORDERING came from the index, not from a sort on top of it.
 *
 * Separate from {@link expectIndexed} because the two failures look identical in
 * the index name: a `DESC NULLS FIRST` ordering against a `DESC NULLS LAST`
 * index still uses that index as a predicate scan and then sorts everything it
 * returned. Only the plan SHAPE tells them apart.
 */
function expectNoSort(probe: string): void {
  expect(`${probe} sorts: ${plans.get(probe)?.includes('Sort Key:') ?? 'NO PLAN'}`).toBe(
    `${probe} sorts: false`
  );
}

/** Every index partial on `archived = false` — the five room listings. */
const ROOM_LISTING_INDEXES = [
  'rooms_status_created_at_idx',
  'rooms_house_id_status_created_at_idx',
  'rooms_host_status_created_at_idx',
  'rooms_type_status_created_at_idx',
  'rooms_owner_type_type_status_created_at_idx',
];

describe('the seed is real', () => {
  it('inserted the rows the plans were measured against', () => {
    // Not decoration: on a seed that inserted nothing, every plan below is a
    // measurement of an empty table and every "no Seq Scan" assertion passes
    // for the wrong reason.
    expect(seededRoomCount).toBe(SEEDED_ROOMS);
    expect(seededHouseCount).toBe(SEEDED_HOUSES);
    expect(seededRecordingCount).toBe(SEEDED_RECORDINGS);
  });

  it('the control still reports a table scan under enable_seqscan = off', () => {
    expect(plans.get('control')).toContain('Seq Scan on rooms');
  });

  it('collected a plan for every probe', () => {
    // A probe whose EXPLAIN silently returned nothing would make its own
    // assertions compare `undefined` against a substring and pass.
    expect(PROBES.filter((probe) => !plans.get(probe.name)).map((probe) => probe.name)).toEqual([]);
  });
});

describe('room listings reach a partial listing index and do not sort', () => {
  for (const probe of ['roomsDefault', 'roomsByHouse', 'roomsByHost', 'roomsByType', 'roomsByOwnerType']) {
    it(`${probe} is indexed`, () => {
      expectIndexed(probe, 'rooms');
      expectIndexAmong(probe, ROOM_LISTING_INDEXES);
    });
  }

  it('roomsSingleStatus is indexed', () => {
    expectIndexed('roomsSingleStatus', 'rooms');
    expectIndexAmong('roomsSingleStatus', ROOM_LISTING_INDEXES);
  });

  /**
   * ONLY the single-status listing takes its ordering from the index, and that
   * is a property of the schema rather than a shortfall of the port.
   *
   * Every listing index is `(…filter…, status, created_at DESC NULLS LAST)`, so
   * `created_at` is ordered only WITHIN one status. The default listing and the
   * four filtered ones all carry `status in ('live', 'scheduled')` — a
   * two-value set — and an index scan cannot produce one ordered stream across
   * two status values, so the planner bitmap-scans and top-N sorts. Measured:
   * `roomsDefault` sorts 18,182 rows to return 21.
   *
   * An earlier version of this suite asserted `expectNoSort('roomsDefault')` on
   * the reasoning that the default "narrows on status alone". It does not — it
   * narrows on two status VALUES, which is the opposite case. Asserting no sort
   * there would have been asserting something the schema does not promise.
   *
   * Mongo's `{ status: { $in: [...] } }` with `sort({ createdAt: -1 })` had the
   * identical shape against `{ status: 1, createdAt: -1 }`, so this is carried
   * forward rather than introduced. Reported as a standing cost, not fixed here:
   * closing it means a `created_at`-leading partial index, which is a schema
   * change and a different question from porting.
   */
  it('roomsSingleStatus takes its ordering from the index; the two-value default cannot', () => {
    expectNoSort('roomsSingleStatus');
    // Stated as an expectation rather than left unasserted, so a future index
    // that DOES serve the two-value form shows up here as a failure to read
    // rather than as silence.
    expect(plans.get('roomsDefault')).toContain('Sort Key: created_at DESC NULLS LAST');
  });

  it('the rejected desc() spelling still sorts where descNullsLast does not', () => {
    // The finding this suite exists for, on the one probe that can show it:
    // `desc()` emits DESC (NULLS FIRST) against a DESC NULLS LAST index, so the
    // pathkeys never match and 9,091 live rooms are sorted to return 21.
    expect(plans.get('roomsSingleStatusNullsFirst')).toContain('Sort Key:');
    // The pair is what makes it a measurement: same predicate, same index,
    // different nulls placement, and only one of them sorts.
    expectNoSort('roomsSingleStatus');
  });
});

describe('the live-badge feed', () => {
  it('reaches an index once it carries archived = false', () => {
    expectIndexed('liveUsers', 'rooms');
    expectIndexAmong('liveUsers', ROOM_LISTING_INDEXES);
  });

  it('scans the whole table without it — the shape Mongo shipped', () => {
    // The proof that the PREDICATE and not the column list is what excluded it:
    // the two probes differ only by `and archived = false`.
    expect(plans.get('liveUsersUnfiltered')).toContain('Seq Scan on rooms');
  });
});

describe('houses', () => {
  it('the discovery listing is indexed and does not sort', () => {
    expectIndexed('housesListing', 'houses');
    expectIndexAmong('housesListing', ['houses_visibility_discovery_created_at_idx']);
    expectNoSort('housesListing');
  });

  /**
   * The other finding this suite exists for.
   *
   * `NOT IN` renders as `<> ALL (…)`, which no btree can serve, so the first
   * version of `listHouses` sequential-scanned `houses` and top-N sorted on the
   * single most-requested listing in this vertical — with the index that exists
   * for it sitting unused. The shipped form asks the same question as `IN` over
   * the discoverable complement and is an Index Scan with no sort.
   */
  it('the NOT IN spelling — the one first written — still scans', () => {
    expect(plans.get('housesListingNotIn')).toContain('Seq Scan on houses');
    // The pair is the measurement: same rows, same ordering, one indexable.
    expectIndexed('housesListing', 'houses');
  });

  /**
   * The arm the route actually takes, and the one the first version of this
   * suite did not have.
   *
   * `housesListing` above is the ANONYMOUS caller. `GET /api/houses` is mounted
   * behind required auth, so that arm never runs — and the membership arm was a
   * Seq Scan while the suite was green. Its WHERE clause is built by
   * `houseListingConditions`, so a change to the shipped predicate moves this
   * probe with it.
   */
  it('the authenticated listing — the arm that runs — reaches an index', () => {
    expectIndexed('housesListingAuthed', 'houses');
    // A `BitmapOr` of the discovery index and the primary key: the two arms of
    // the `OR` are each indexable once membership is an id list rather than a
    // correlated subquery.
    expectIndexAmong('housesListingAuthed', [
      'houses_visibility_discovery_created_at_idx',
      'houses_pkey',
    ]);
  });

  it('the correlated EXISTS it replaced still scans', () => {
    // The measurement that makes the fix mean something: same question, same
    // rows, and an `OR` the planner cannot combine.
    expect(plans.get('housesListingExists')).toContain('Seq Scan on houses');
    expectIndexed('housesListingAuthed', 'houses');
  });

  it('the probed member really is in many houses', () => {
    // A vacuity floor for the two assertions above. With a handful of member
    // houses the planner's choice says nothing about the shape at scale, and a
    // seed whose `on conflict do nothing` swallowed every row would leave the
    // membership arm absent from the predicate entirely.
    expect(seededMemberHouseIds.length).toBeGreaterThan(1000);
  });

  it('the GIN index serves the search predicate', () => {
    expectIndexed('housesSearchOnly', 'houses');
    expect(indexesIn('housesSearchOnly')).toContain('houses_search_gin');
  });

  /**
   * The FULL search query is indexed, but not necessarily by the GIN index, and
   * that is the planner's call rather than something to pin.
   *
   * Measured: with `visibility_discovery` newly indexable (see above) and a
   * `LIMIT 21`, the planner walks `houses_visibility_discovery_created_at_idx`
   * in `created_at` order and applies the `tsquery` as a filter — cheaper than a
   * GIN bitmap plus a sort when matches are common enough to fill 21 rows
   * quickly. On a rare term it would prefer the GIN. Both are correct; asserting
   * which would be asserting the selectivity of the seed's search terms.
   */
  it('the full search query reaches an index either way', () => {
    expectIndexed('housesSearch', 'houses');
    expectIndexAmong('housesSearch', [
      'houses_search_gin',
      'houses_visibility_discovery_created_at_idx',
    ]);
  });

  it('houseIdsWithRoomsHiddenFrom reaches an index on both sides', () => {
    expectIndexed('hiddenHouseIds', 'houses');
    expectIndexed('hiddenHouseIds', 'house_members');
    // The `rooms` axis index exists so this can be an index union rather than a
    // scan; the anti-join side uses the roster's own unique index.
    expect(indexesIn('hiddenHouseIds')).toContain('houses_visibility_rooms_idx');
  });

  it('the roster reads are indexed in both directions', () => {
    expectIndexed('houseRoster', 'house_members');
    expectIndexed('rostersByHouseIds', 'house_members');
    expectIndexed('housesForMember', 'house_members');
    // The reverse direction is the one the unique `(house_id, oxy_user_id)`
    // index cannot serve, which is why the standalone index exists.
    expect(indexesIn('housesForMember')).toContain('house_members_oxy_user_id_idx');
  });
});

describe('series', () => {
  /**
   * Indexed, and the sort is left unasserted DELIBERATELY.
   *
   * Both `series_house_id_active_created_at_idx` (partial, ordered) and
   * `series_house_id_idx` (non-partial, unordered) can answer this predicate,
   * and the planner picks by cost. Measured at 573 rows for the probed house it
   * chose the bitmap plus a quicksort of 476 rows — a rational choice for a
   * listing with NO `LIMIT`, which has to read every row anyway. The ordering
   * key it produced is `created_at DESC NULLS LAST`, matching the index, so
   * this is a costing decision and not the pathkey mismatch that
   * `roomsSingleStatusNullsFirst` catches. Asserting no sort here would be
   * asserting a cost estimate that moves with the statistics.
   */
  it('the house listing reaches one of the two house_id indexes', () => {
    expectIndexed('seriesForHouse', 'series');
    expectIndexAmong('seriesForHouse', [
      'series_house_id_active_created_at_idx',
      'series_house_id_idx',
    ]);
  });

  it('the episode log is indexed', () => {
    expectIndexed('seriesEpisodes', 'series_episodes');
  });
});

describe('recordings', () => {
  it('the public listing uses the partial index and does not sort', () => {
    expectIndexed('recordingsRecent', 'recordings');
    expectIndexAmong('recordingsRecent', ['recordings_ready_public_created_at_idx']);
    expectNoSort('recordingsRecent');
  });

  it('the per-room listing is indexed', () => {
    expectIndexed('roomRecordings', 'recordings');
    expectIndexAmong('roomRecordings', ['recordings_room_id_status_created_at_idx']);
  });

  it('the participant containment read reaches the GIN index', () => {
    expectIndexed('participantRecordings', 'recordings');
    expect(indexesIn('participantRecordings')).toContain('recordings_participant_ids_gin');
  });

  it('the egress lookup uses the unique index', () => {
    expectIndexed('recordingByEgress', 'recordings');
    expect(indexesIn('recordingByEgress')).toContain('recordings_egress_id_key');
  });

  it('top-hosts uses the ready-only partial index', () => {
    expectIndexed('topHosts', 'recordings');
    expect(indexesIn('topHosts')).toContain('recordings_ready_host_idx');
  });

  it('the existence probe is indexed', () => {
    expectIndexed('roomHasRecording', 'recordings');
  });
});

describe('room queue and preferences', () => {
  it('the queue read is indexed', () => {
    expectIndexed('roomQueue', 'room_media_queue_items');
    expectIndexAmong('roomQueue', ['room_media_queue_items_room_id_position_key']);
    // The sort is NOT asserted, for the same reason as `seriesForHouse`: the
    // unique `(room_id, position)` index could supply the order, and at 2,143
    // items for the probed room the planner chose a bitmap plus a quicksort
    // instead. `Sort Key: "position"` matches the index, so the ordering is
    // correct and only the access path differs — a costing decision.
  });

  it('the ingress lookup uses the partial index', () => {
    expectIndexed('roomByIngress', 'rooms');
    expect(indexesIn('roomByIngress')).toContain('rooms_active_ingress_id_idx');
  });

  it('the batched preference read is indexed', () => {
    expectIndexed('livePreferences', 'room_user_preferences');
  });
});

/**
 * The five `ON DELETE SET NULL` support indexes, probed with the query Postgres
 * itself runs.
 *
 * Enumerated rather than counted, matching `gates.test.ts`'s treatment of the
 * same set — a count agrees with itself while naming the wrong index, and the
 * whole point of these five is that each is easy to mistake for a listing index
 * that already exists. Before `rooms_house_id_idx` existed, deleting a house
 * sequential-scanned the whole `rooms` table even though
 * `rooms_house_id_status_created_at_idx` looked like it covered it — it is
 * partial on `archived = false`, and the RI query below carries no such clause.
 */
describe('the constraint-support indexes serve the referential-integrity queries', () => {
  const RI_PROBES: readonly { readonly probe: string; readonly table: string; readonly index: string }[] = [
    { probe: 'riRoomsByHouse', table: 'rooms', index: 'rooms_house_id_idx' },
    { probe: 'riSeriesByHouse', table: 'series', index: 'series_house_id_idx' },
    { probe: 'riRoomsBySeries', table: 'rooms', index: 'rooms_series_id_idx' },
    { probe: 'riEpisodesByRoom', table: 'series_episodes', index: 'series_episodes_room_id_idx' },
    {
      probe: 'riRecordingsByRoom',
      table: 'recordings',
      index: 'recordings_room_id_status_created_at_idx',
    },
  ];

  it('covers all five, none of them missing', () => {
    expect(RI_PROBES.length).toBe(5);
  });

  for (const { probe, table, index } of RI_PROBES) {
    it(`${probe} uses ${index} rather than scanning ${table}`, () => {
      expectIndexed(probe, table);
      expect(`${probe}: ${indexesIn(probe).join(', ')}`).toContain(index);
    });
  }
});
