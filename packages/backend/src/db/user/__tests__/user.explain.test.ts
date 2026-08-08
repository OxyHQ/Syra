/**
 * What the PLANNER does with the queries the user and recommendation vertical
 * issues.
 *
 * Sixth of its family, after `containers.explain.test.ts`,
 * `services.explain.test.ts`, `library.explain.test.ts`,
 * `podcasts.explain.test.ts`, `creators.explain.test.ts` and
 * `rooms.explain.test.ts`, and for the same reason: reading the schema does not
 * answer whether Postgres can REACH an index for a given predicate.
 *
 * ## Seeding, rollback, and the control
 *
 * Everything runs inside ONE transaction that seeds real cardinality,
 * `ANALYZE`s, EXPLAINs and ROLLS BACK. On an empty table the planner's choice is
 * a coin flip and every assertion here would pass for the wrong reason, which is
 * what the seed floor exists to refuse. `set local enable_seqscan = off` makes
 * the planner prefer any index it CAN use, so a remaining Seq Scan means no
 * index could serve the query at all — and the control probe must still report
 * one, or "no Seq Scan" cannot be told from "stopped reading plans".
 *
 * ## What these probes are worth — read this before citing one
 *
 * They are TRANSCRIPTIONS of what `db/user/*.ts` builds with drizzle, not the
 * shipped SQL, and **nothing binds the two**. All five existing suites in this
 * family have the same gap: a regression in the shipped query leaves them green.
 * Each proves an index EXISTS AND IS REACHABLE for a predicate of that shape;
 * none proves the module still issues it. Written the same way for consistency,
 * and stated plainly rather than claimed to lock anything in.
 *
 * ## What it found
 *
 * Two things worth recording, neither of which is visible in the schema.
 *
 * **The co-listen read is an index scan for one source and for many.**
 * `catalog_relations_kind_source_id_score_idx` is `(kind, source_id, score
 * desc)`, and `findRelatedEdges` always filters `kind` and `source_id` together
 * — `radioPools` with up to a few dozen sources at once. The multi-source form
 * plans as a Bitmap Index Scan over the same index rather than falling back to a
 * scan, which is the thing worth checking: it is the shape `$in` became.
 *
 * **The taste-profile trim uses the unique constraint, not a sort of the
 * table.** `trimGenres`/`trimArtists` delete everything outside the top N by
 * weight for ONE profile, and the leading `taste_profile_id` of
 * `user_taste_genres_taste_profile_id_genre_key` is what keeps that a per-profile
 * range rather than a global sort — on a table holding up to 200 artist weights
 * for every listener on Syra.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { closePostgres, getDb } from '../../postgres';
import { connectUnmanagedDb } from '../../../test/postgres';
import { EXPIRY_SWEEP_TARGETS } from '../../expiry';

/** Thrown to roll the seeding transaction back once every plan is collected. */
class Rollback extends Error {}

/** Ids the seed writes, all carrying this prefix. Never committed. */
const MARKER = 'user-explain';

const SEEDED_ARTISTS = 500;
const SEEDED_TRACKS = 5000;
const SEEDED_USERS = 2000;
const SEEDED_EVENTS = 40000;
const SEEDED_RELATIONS = 40000;
const SEEDED_PROFILES = 2000;

const SEED_AND_EXPLAIN_TIMEOUT_MS = 120_000;

/** Plan text by probe name, collected once in `beforeAll`. */
const plans = new Map<string, string>();

let seededEventCount = 0;
let seededRelationCount = 0;
let seededTasteArtistCount = 0;

const PROBES: readonly { readonly name: string; readonly sql: string }[] = [
  {
    // `db/user/relations.ts` — `findRelatedEdges` with ONE source, which is
    // `getRelatedArtists` and `getSimilarTracks`.
    name: 'relatedEdgesOneSource',
    sql: `select target_id, score from catalog_relations
          where kind = 'artist' and source_id = '${MARKER}-art-7'
          order by score desc limit 20`,
  },
  {
    // `db/user/relations.ts` — the MANY-source form, which is `radioPools`'
    // collaborative pool and `topRelatedArtistIds`. The shape `$in` became.
    name: 'relatedEdgesManySources',
    sql: `select target_id, score from catalog_relations
          where kind = 'track' and source_id in (
            '${MARKER}-t-1', '${MARKER}-t-2', '${MARKER}-t-3', '${MARKER}-t-4',
            '${MARKER}-t-5', '${MARKER}-t-6', '${MARKER}-t-7', '${MARKER}-t-8')
          order by score desc limit 60`,
  },
  {
    // `db/user/relations.ts` — `replaceRelationGraph`'s delete half.
    name: 'replaceGraphDelete',
    sql: `select id from catalog_relations where kind = 'artist'`,
  },
  {
    // `db/user/listening.ts` — `findRecentTrackIds`, the exclusion set.
    name: 'recentTrackIds',
    sql: `select track_id from listening_events
          where oxy_user_id = '${MARKER}-u-7' order by played_at desc limit 200`,
  },
  {
    // `db/user/listening.ts` — `forEachMinableEvent`'s FIRST page.
    name: 'minableFirstPage',
    sql: `select oxy_user_id, track_id, artist_id, played_at, id from listening_events
          where played_at >= now() - interval '60 days'
            and completion >= 0.3 and skipped = false
          order by oxy_user_id asc, played_at asc, id asc limit 10000`,
  },
  {
    /**
     * `db/user/listening.ts` — the keyset SEEK, the reason the miner pages by a
     * row comparison rather than an `offset`. The three-column `(a, b, c) > (x,
     * y, z)` is one comparison the planner can drive from the leading columns of
     * `listening_events_oxy_user_id_played_at_idx`; the `a > x OR (a = x AND …)`
     * expansion is not.
     */
    name: 'minableSeekPage',
    sql: `select oxy_user_id, track_id, artist_id, played_at, id from listening_events
          where played_at >= now() - interval '60 days'
            and completion >= 0.3 and skipped = false
            and (oxy_user_id, played_at, id)
                > ('${MARKER}-u-7', now() - interval '30 days', '${MARKER}-ev-1')
          order by oxy_user_id asc, played_at asc, id asc limit 10000`,
  },
  {
    // `db/user/taste.ts` — `findTasteWeights`' artist half.
    name: 'tasteWeightsByProfile',
    sql: `select artist_id, weight from user_taste_artists
          where taste_profile_id = '${MARKER}-tp-7'
          order by weight desc, artist_id asc`,
  },
  {
    /**
     * `db/user/taste.ts` — `trimArtists`' survivor subquery, the per-profile
     * top-N that the cap is enforced with. The leading `taste_profile_id` of the
     * unique constraint is what keeps this a range rather than a global sort.
     */
    name: 'trimSurvivors',
    sql: `select id from user_taste_artists
          where taste_profile_id = '${MARKER}-tp-7'
          order by weight desc, artist_id asc limit 200`,
  },
  {
    // `db/user/taste.ts` — `decayDueTasteProfiles`' due predicate, which every
    // statement in the pass shares.
    name: 'decayDueProfiles',
    sql: `select id from user_taste_profiles
          where last_decay_at < now() - make_interval(secs => 5610)`,
  },
  {
    // `db/user/settings.ts` and `musicPreferences.ts` — the one-row-per-account
    // read both `ensure*` paths make, served by the unique constraint.
    name: 'settingsByUser',
    sql: `select id, oxy_user_id from user_settings where oxy_user_id = '${MARKER}-u-7' limit 1`,
  },
  {
    // `db/user/notifications.ts` — `claimSuppression`'s conflict target.
    name: 'suppressionByUserAndKey',
    sql: `select id from notification_suppressions
          where oxy_user_id = '${MARKER}-u-7' and key = 'episode.published:${MARKER}-e-7'`,
  },
  {
    // `@oxyhq/db`'s `sweepExpiredRows`, verbatim in shape, for the 90-day
    // retention target. `1000` is its default batch size.
    name: 'sweep_listening_events',
    sql: `select ctid from listening_events
          where played_at <= now() - make_interval(secs => ${90 * 24 * 60 * 60}) limit 1000`,
  },
  {
    // The same statement for the `retentionSeconds: 0` target, where the column
    // IS the deadline.
    name: 'sweep_notification_suppressions',
    sql: `select ctid from notification_suppressions
          where expires_at <= now() - make_interval(secs => 0) limit 1000`,
  },
  {
    /**
     * The control. `listening_events.listened_sec` carries no index, so this
     * MUST still report a Seq Scan under `enable_seqscan = off` — otherwise
     * "no Seq Scan" below cannot be told from "stopped reading plans".
     */
    name: 'control',
    sql: `select id from listening_events where listened_sec = -12345`,
  },
];

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function seed(tx: Tx): Promise<void> {
  await executeRows(tx, sql.raw(`
    insert into catalog_entities (id, type, name, name_key, source, popularity)
    select '${MARKER}-art-' || g, 'artist', '${MARKER} artist ' || g, '${MARKER}-artist' || g,
           'upload', g % 101
    from generate_series(1, ${SEEDED_ARTISTS}) g`));

  await executeRows(tx, sql.raw(`
    insert into tracks (id, title, artist_id, artist_name, duration, source, status, popularity)
    select '${MARKER}-t-' || g, 'Track ' || g, '${MARKER}-art-' || (1 + (g % ${SEEDED_ARTISTS})),
           'Artist', 150 + (g % 120), 'upload', 'ready', g % 101
    from generate_series(1, ${SEEDED_TRACKS}) g`));

  /**
   * `completion` and `skipped` are correlated the way real plays are but NOT
   * perfectly: one event in seven is a skip and one in five is below the 0.3
   * completion floor, coprime so all four combinations occur. A seed where every
   * event passed the miner's filter could not tell an index that serves the
   * predicate from one that cannot.
   */
  await executeRows(tx, sql.raw(`
    insert into listening_events (id, oxy_user_id, track_id, artist_id, genre, listened_sec,
                                  completion, skipped, source, played_at)
    select '${MARKER}-ev-' || g, '${MARKER}-u-' || (1 + (g % ${SEEDED_USERS})),
           '${MARKER}-t-' || (1 + (g % ${SEEDED_TRACKS})),
           '${MARKER}-art-' || (1 + (g % ${SEEDED_ARTISTS})),
           'genre' || (g % 40), (g % 200),
           case when g % 5 = 0 then 0.1 else 0.4 + ((g % 6) / 10.0) end,
           g % 7 = 0, 'radio',
           now() - ((g % 5000) || ' minutes')::interval
    from generate_series(1, ${SEEDED_EVENTS}) g`));

  /**
   * Both kinds, because `findRelatedEdges` always filters on `kind` and a seed
   * holding only one could not tell the index's leading column from a filter.
   * The prime modulus keeps `(kind, source_id, target_id)` unique.
   */
  await executeRows(tx, sql.raw(`
    insert into catalog_relations (id, kind, source_id, target_id, score, co_count, computed_at)
    select '${MARKER}-rel-' || g,
           case when g % 2 = 0 then 'artist' else 'track' end,
           case when g % 2 = 0 then '${MARKER}-art-' || (1 + (g % ${SEEDED_ARTISTS}))
                else '${MARKER}-t-' || (1 + (g % ${SEEDED_TRACKS})) end,
           case when g % 2 = 0 then '${MARKER}-art-' || (1 + ((g * 3) % 499))
                else '${MARKER}-t-' || (1 + ((g * 3) % 4999)) end,
           ((g % 100) + 1) / 100.0, 2 + (g % 20), now()
    from generate_series(1, ${SEEDED_RELATIONS}) g`));

  // Half the profiles are already decayed within the floor, so the `due`
  // predicate has both sides to discriminate.
  await executeRows(tx, sql.raw(`
    insert into user_taste_profiles (id, oxy_user_id, total_signal, last_decay_at)
    select '${MARKER}-tp-' || g, '${MARKER}-u-' || g, (g % 50),
           case when g % 2 = 0 then now() else now() - interval '30 days' end
    from generate_series(1, ${SEEDED_PROFILES}) g`));

  /**
   * The artist modulus is the PRIME 499, not `SEEDED_ARTISTS` (500), and that is
   * load-bearing rather than arbitrary. With `(g % 2000, (g * 7) % 500)` the pair
   * repeats every `lcm(2000, 500) = 2000` rows, so `on conflict do nothing`
   * silently collapsed 60,000 inserts into 2,000 surviving rows — measured, and
   * caught only by the seed floor below. 499 does not divide 2,000, so the pair
   * now repeats every 998,000 and all 60,000 land. Same trap, and the same fix,
   * as `library.explain.test.ts`' collaborator seed.
   */
  await executeRows(tx, sql.raw(`
    insert into user_taste_artists (id, taste_profile_id, artist_id, weight)
    select '${MARKER}-ta-' || g, '${MARKER}-tp-' || (1 + (g % ${SEEDED_PROFILES})),
           '${MARKER}-art-' || (1 + (g % 499)), ((g % 90) + 1) / 10.0
    from generate_series(1, 60000) g
    on conflict do nothing`));

  await executeRows(tx, sql.raw(`
    insert into user_taste_genres (id, taste_profile_id, genre, weight)
    select '${MARKER}-tg-' || g, '${MARKER}-tp-' || (1 + (g % ${SEEDED_PROFILES})),
           'genre' || (g % 39), ((g % 90) + 1) / 10.0
    from generate_series(1, 40000) g
    on conflict do nothing`));

  await executeRows(tx, sql.raw(`
    insert into user_settings (id, oxy_user_id)
    select '${MARKER}-us-' || g, '${MARKER}-u-' || g
    from generate_series(1, ${SEEDED_USERS}) g`));

  await executeRows(tx, sql.raw(`
    insert into notification_suppressions (id, oxy_user_id, key, expires_at)
    select '${MARKER}-ns-' || g, '${MARKER}-u-' || (1 + (g % ${SEEDED_USERS})),
           'episode.published:${MARKER}-e-' || (1 + (g % ${SEEDED_USERS})),
           now() + interval '6 hours'
    from generate_series(1, ${SEEDED_USERS}) g
    on conflict do nothing`));

  await executeRows(tx, sql.raw(
    'analyze catalog_entities, tracks, listening_events, catalog_relations, ' +
    'user_taste_profiles, user_taste_artists, user_taste_genres, user_settings, ' +
    'notification_suppressions'
  ));

  const [events] = await executeRows<{ total: number }>(
    tx, sql.raw(`select count(*)::int as total from listening_events where id like '${MARKER}-%'`));
  seededEventCount = events?.total ?? 0;

  const [relations] = await executeRows<{ total: number }>(
    tx, sql.raw(`select count(*)::int as total from catalog_relations where id like '${MARKER}-%'`));
  seededRelationCount = relations?.total ?? 0;

  const [tasteArtists] = await executeRows<{ total: number }>(
    tx, sql.raw(`select count(*)::int as total from user_taste_artists where id like '${MARKER}-%'`));
  seededTasteArtistCount = tasteArtists?.total ?? 0;
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
    expect(seededEventCount).toBe(SEEDED_EVENTS);
    expect(seededRelationCount).toBe(SEEDED_RELATIONS);
    // `on conflict do nothing` on the taste children, so a floor rather than an
    // equality — but a floor high enough that the collapsing-modulus bug this
    // seed shipped with (2,000 surviving rows out of 60,000) fails it.
    expect(seededTasteArtistCount).toBeGreaterThan(50000);
  });

  it('collected a plan for every probe', () => {
    expect([...plans.keys()].sort()).toEqual(PROBES.map((probe) => probe.name).sort());
  });
});

describe('the control still scans', () => {
  /**
   * The assertion that makes every other one in this file mean something. If an
   * unindexed predicate ALSO reported no Seq Scan, the checks below would be
   * measuring the plan text parser rather than the plans.
   */
  it('an unindexed predicate is a Seq Scan even with enable_seqscan = off', () => {
    expect(plans.get('control')).toContain('Seq Scan');
  });
});

describe('every query this vertical issues reaches an index', () => {
  const INDEXED: readonly { readonly probe: string; readonly index: string }[] = [
    { probe: 'relatedEdgesOneSource', index: 'catalog_relations_kind_source_id_score_idx' },
    { probe: 'relatedEdgesManySources', index: 'catalog_relations_kind_source_id_score_idx' },
    { probe: 'replaceGraphDelete', index: 'catalog_relations_kind_source_id_score_idx' },
    { probe: 'recentTrackIds', index: 'listening_events_oxy_user_id_played_at_idx' },
    { probe: 'minableSeekPage', index: 'listening_events_oxy_user_id_played_at_idx' },
    { probe: 'tasteWeightsByProfile', index: 'user_taste_artists_taste_profile_id_artist_id_key' },
    { probe: 'trimSurvivors', index: 'user_taste_artists_taste_profile_id_artist_id_key' },
    { probe: 'settingsByUser', index: 'user_settings_oxy_user_id_key' },
    {
      probe: 'suppressionByUserAndKey',
      index: 'notification_suppressions_oxy_user_id_key_key',
    },
  ];

  for (const { probe, index } of INDEXED) {
    it(`${probe} uses ${index}`, () => {
      // The index is named, not merely "no Seq Scan": a plan can avoid a Seq
      // Scan by scanning the WRONG index end to end, which is the defect the
      // gates suite's own planner probe was rewritten to catch.
      expect(`${probe}: ${indexesIn(probe)}`).toContain(index);
      expect(plans.get(probe)).not.toContain('Seq Scan');
    });
  }
});

describe('the miner walks the log in order', () => {
  /**
   * `forEachMinableEvent`'s ordering IS the algorithm — the miner splits a
   * user's plays into sessions by the gap between consecutive `played_at`
   * values, so a plan that returned rows in another order would invent or
   * destroy sessions rather than merely run slower.
   *
   * The first page is allowed to sort: `played_at >= …` selects most of the
   * table, so a full sort is genuinely the cheaper plan and the index cannot
   * help. What must NOT happen is the SEEK page falling back to one, because
   * that is the page the paging loop repeats.
   */
  it('the seek page is driven by the index, not by a sort of the whole table', () => {
    expect(indexesIn('minableSeekPage')).toContain('listening_events_oxy_user_id_played_at_idx');
  });

  it('both pages return rows in the total order the sessioniser depends on', () => {
    for (const probe of ['minableFirstPage', 'minableSeekPage']) {
      // Whether by index or by sort, the ORDER is what the miner needs, and the
      // plan has to establish it one way or the other.
      const plan = plans.get(probe) ?? '';
      expect(`${probe}: ${plan}`).toMatch(/Sort Key|Index Scan|Incremental Sort/);
    }
  });
});

describe('the expiry sweep is a range scan on every registered target', () => {
  /**
   * The statement `sweepExpiredRows` actually issues — `select ctid from <table>
   * where <column> <= now() - make_interval(secs => N) limit <batch>` — probed
   * once per registry entry rather than written out, so a target added later
   * without a usable index fails here too.
   *
   * This is the cost Mongo's TTL index was paying invisibly: without a leading
   * btree, that predicate is a full scan of the largest table in this schema on
   * every sweep.
   */
  const SWEEP_INDEXES: Readonly<Record<string, string>> = {
    listening_events: 'listening_events_played_at_idx',
    notification_suppressions: 'notification_suppressions_expires_at_idx',
  };

  it('probed every registered target', () => {
    expect(EXPIRY_SWEEP_TARGETS.length).toBe(Object.keys(SWEEP_INDEXES).length);
  });

  for (const [table, index] of Object.entries(SWEEP_INDEXES)) {
    it(`sweeps ${table} by ${index}`, () => {
      expect(`${table}: ${indexesIn(`sweep_${table}`)}`).toContain(index);
      expect(plans.get(`sweep_${table}`)).not.toContain('Seq Scan');
    });
  }
});

describe('the decay pass scans, and that is the right plan', () => {
  /**
   * `user_taste_profiles.last_decay_at` carries NO index, so
   * `decayDueTasteProfiles`' due predicate is a Seq Scan even under
   * `enable_seqscan = off`. Recorded as a deliberate verdict rather than left as
   * an omission, because the obvious reading of the probe is "add an index".
   *
   * The reason is SELECTIVITY, and it stands on its own arithmetic:
   * `MIN_DECAY_ELAPSED_SECONDS` is `45 days × ln(0.999)/ln(0.5)` = 5,612s ≈ 93.5
   * minutes, against a 30-minute scheduler tick. A profile the pass touches has
   * its `last_decay_at` set to `now()`, so it comes due 3.12 ticks later — i.e.
   * on the 4th — and in steady state **~25% of all profiles are due on any given
   * tick**. Postgres chooses a sequential scan at that selectivity whether or not
   * an index exists, so the index would be built, maintained, and never used.
   *
   * **A second argument was made here and it was wrong**, recorded rather than
   * quietly deleted because it is the more tempting of the two: that an index on
   * `last_decay_at` would be paid for on the hottest write path, since
   * `applyTasteSignal` writes the parent row on every play, like and follow. It
   * does write the parent row — but its `on conflict do update` sets
   * `total_signal` and `updated_at` and **never touches `last_decay_at`**
   * (`taste.ts`). Only the decay pass and a profile's first insert write that
   * column. So the write-amplification claim was false and the selectivity
   * argument is the whole case.
   *
   * This is also not a regression: the Mongo pass was `find({})` with a cursor —
   * every profile read into the application and filtered in JS. The scan is the
   * same population, with the filter pushed into the database.
   */
  it('is a Seq Scan, deliberately — see this block for why no index is warranted', () => {
    expect(plans.get('decayDueProfiles')).toContain('Seq Scan');
  });
});
