/**
 * What the PLANNER does with the queries Task 12's podcast vertical issues.
 *
 * Fourth of its family, after `db/catalog/__tests__/containers.explain.test.ts`,
 * `services.explain.test.ts` and `db/library/__tests__/library.explain.test.ts`,
 * and for the same reason: on this branch a definition assertion has certified a
 * query that turned out to be a Seq Scan several times over. Reading
 * `schema/podcasts.ts` does not answer whether Postgres can REACH the index it
 * declares for a given predicate.
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
 * use, so a remaining Seq Scan means no index could serve the query at all. The
 * control probe — a predicate no index covers — must still report one, or "no
 * Seq Scan" cannot be told from "stopped reading plans".
 *
 * ## What it found
 *
 * **The ordering, and it is the whole reason `descNullsLast` is used
 * throughout.** Postgres `DESC` defaults to `NULLS FIRST`, but drizzle emits
 * `.desc()` in an INDEX definition as `DESC NULLS LAST` — so the two spellings
 * do not match, and only one of them can STREAM the ordered index. Measured on
 * the seed below, `podcasts` browse-by-recency, 4,900 active shows:
 *
 *   desc nulls last   Index Scan, stops at 20        cost   3.13   0.016 ms
 *   desc              Index Scan of all 4,900 rows
 *                     + top-N heapsort               cost 828.26   1.062 ms
 *
 * Both reach the index — an earlier revision of this comment said the plain
 * form fell to a Seq Scan, measured on a differently-shaped table, and that is
 * NOT what reproduces here. The difference that does reproduce is the one that
 * matters: the correct spelling costs the PAGE, the wrong one costs the whole
 * result set, so it degrades as the catalogue grows rather than being wrong at
 * any one size.
 *
 * **The GIN indexes are reached only for a SELECTIVE term**, which is why the
 * seed plants a rare token rather than searching for one every row carries. A
 * query matching most of the catalogue is served by the ordering index with the
 * tsquery as a filter — the right plan for that case, and a probe whose term
 * matched everything measured exactly that while claiming to measure the GIN.
 * The first version of this file did that; the fixture, not the schema, was
 * wrong.
 *
 * **And even with a selective term, any query carrying the `status` filter
 * alternates between two indexed plans**, because three partial indexes on
 * `podcasts` are predicated on `status = 'active'` and scanning one of them with
 * the tsquery as a filter costs about what the GIN bitmap does. Measured: the
 * `status`-carrying count probe passed 20 consecutive standalone runs and failed
 * BOTH full-suite runs, on nothing but the statistics the rest of the suite
 * leaves behind. So the GIN assertion sits on probes carrying only the tsquery,
 * where exactly one index is applicable. Pinning a coin flip is how a gate
 * becomes the thing that gets disabled.
 *
 * **At this seed size a sequential scan legitimately beats the GIN.** Over 5,000
 * shows at default costing: Seq Scan 261.50, GIN index scan alone 352.92. That
 * is the ruling's own argument playing out rather than failing — the GIN costs a
 * function of MATCHES and the scan a function of CATALOGUE SIZE, so the
 * crossover is ahead of a 5,000-row seed. It is why the GIN probes are read from
 * the `enable_seqscan = off` pass, which asks "can the index serve this at all"
 * rather than "is it cheapest today".
 *
 * `descNullsLast` is ALSO the faithful ordering (Mongo sorts a missing field
 * lowest, which is NULLS LAST descending), so the correct spelling and the fast
 * one are the same spelling. The rejected form is kept as a probe below and
 * asserted to STILL sort, otherwise that is a claim rather than a measurement.
 *
 * ## What these probes are worth
 *
 * They are TRANSCRIPTIONS of what `db/podcasts/*.ts` builds with drizzle, not
 * the shipped SQL, and nothing binds the two — the same caveat its three
 * siblings state about themselves. Each proves an index EXISTS AND IS REACHABLE
 * for a predicate of that shape; none proves the module still issues it. When
 * one of those queries changes its `WHERE`, change the probe with it, because no
 * gate will say so.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { closePostgres, getDb } from '../../postgres';
import { connectUnmanagedDb } from '../../../test/postgres';
import { episodesByShowQuery } from '../episodes';
import { episodeVisibilityFilter } from '../visibility';
import { expectIndexesWithin } from '../../__tests__/explainIndexes';

/** Thrown to roll the seeding transaction back once every plan is collected. */
class Rollback extends Error {}

/** Ids the seed writes, all carrying this prefix. Never committed. */
const MARKER = 'pod-explain';

const SEEDED_SHOWS = 5000;
const SEEDED_EPISODES = 40000;
const SEEDED_USERS = 2000;

const SEED_AND_EXPLAIN_TIMEOUT_MS = 120_000;

/**
 * The show the episode probes target, and the account the seed makes its owner.
 *
 * Derived with the seed's own arithmetic (`'${MARKER}-u-' || (1 + (g % SEEDED_USERS))`)
 * rather than written out, so the owner arm cannot quietly become the stranger
 * arm if the seed's user count changes — which would make both probes measure
 * `status = 'ready'` while still passing.
 */
const PROBED_SHOW_NUMBER = 7;
const PROBED_SHOW = `${MARKER}-s-${PROBED_SHOW_NUMBER}`;
const SEEDED_SHOW_OWNER = `${MARKER}-u-${1 + (PROBED_SHOW_NUMBER % SEEDED_USERS)}`;

/**
 * The show-episode listing, rendered from the SHIPPED builder.
 *
 * This is the one BOUND probe in this file, and the reason it is this one:
 * `findEpisodesByShow`'s visibility condition is INJECTED by the caller
 * (`episodeVisibilityFilter`, `db/podcasts/visibility.ts`), so a transcription
 * has two independent ways to drift — the predicate and the ordering — and the
 * ordering is the property this suite exists to measure. `descNullsLast` streams
 * `episodes_podcast_id_pub_date_idx`; a plain `desc()` is `NULLS FIRST`, which
 * no index on this table provides. A hand-typed `order by pub_date desc nulls
 * last` keeps passing after the module stops saying that.
 *
 * `toSQL()` gives the statement drizzle would send with `$n` placeholders;
 * `EXPLAIN` goes through `sql.raw`, so they are inlined. Every value is a marker
 * string this file generated — nothing user-supplied reaches the statement.
 *
 * `viewerId` decides which arm is measured: the owner's id yields `undefined`
 * (no status condition at all) and a stranger's yields `status = 'ready'`. Both
 * come from the real function, so the two probes cannot disagree with it about
 * what a viewer sees.
 */
function showEpisodesSql(viewerId: string | null): string {
  const query = episodesByShowQuery(PROBED_SHOW, {
    visibility: episodeVisibilityFilter(SEEDED_SHOW_OWNER, viewerId),
    limit: 20,
  }).toSQL();

  return query.sql.replace(/\$(\d+)/g, (_match, index) =>
    `'${String(query.params[Number(index) - 1])}'`
  );
}

/** Plan text by probe name, collected once in `beforeAll`. */
const plans = new Map<string, string>();

/** Rows actually visible inside the seeding transaction. */
let seededShowCount = 0;
let seededEpisodeCount = 0;

interface Probe {
  readonly name: string;
  /**
   * A thunk where the statement has to be BUILT rather than written — a bound
   * probe calls `getDb()`, which does not exist at module load. Resolved in
   * `beforeAll`, after the connection. Same shape `rooms.explain` uses.
   */
  readonly sql: string | (() => string);
  /**
   * Also EXPLAIN this probe with `enable_seqscan` at its default, stored under
   * `<name>:default`. Set for the probes whose question is "which index does
   * the planner WANT" rather than "is any index reachable" — see the two-pass
   * note in `beforeAll`.
   */
  readonly alsoAtDefaultCosting?: boolean;
}

const PROBES: readonly Probe[] = [
  {
    // `db/podcasts/podcasts.ts` — `browsePodcastRows`, the "popular" sort, and
    // the leading-column prefix `searchPodcastRows`' three-key sort also uses.
    name: 'browsePopular',
    sql: `select * from podcasts where status = 'active'
          order by popularity desc nulls last, subscriber_count desc nulls last limit 20`,
  },
  {
    // `db/podcasts/podcasts.ts` — `browsePodcastRows`, the "recent" sort.
    name: 'browseRecent',
    sql: `select * from podcasts where status = 'active'
          order by last_episode_at desc nulls last limit 20`,
  },
  {
    /**
     * The SPELLING THAT WAS REJECTED, kept so the finding cannot be undone
     * silently. Plain `desc` is `NULLS FIRST`, which no index on this table
     * provides — drizzle builds them all `DESC NULLS LAST` — so the ordering
     * cannot be STREAMED and every matching row has to be sorted. Asserted
     * below to still carry that `Sort` node, which is what makes
     * `descNullsLast`'s measurement mean something.
     */
    name: 'browseRecentNullsFirst',
    sql: `select * from podcasts where status = 'active'
          order by last_episode_at desc limit 20`,
  },
  {
    // `db/podcasts/podcasts.ts` — `browsePodcastRows`' category filter, after
    // the name has been resolved to a genre id.
    name: 'browseCategory',
    sql: `select * from podcasts where status = 'active'
            and exists (select 1 from podcast_categories
                        where podcast_id = podcasts.id and genre_id = '${MARKER}-g-3')
          order by popularity desc nulls last limit 20`,
  },
  {
    // `db/podcasts/podcasts.ts` — the genre-NAME lookup that feeds it.
    name: 'genreByName',
    sql: `select id from genres where lower(name) = lower('${MARKER} Category 3') and kind = 'podcast' limit 1`,
  },
  {
    // `db/podcasts/podcasts.ts` — `searchPodcastRows`, through the GIN index.
    name: 'searchPodcasts',
    sql: `select * from podcasts
          where status = 'active' and search_vector @@ websearch_to_tsquery('english', 'zebra')
          order by popularity desc nulls last, subscriber_count desc nulls last,
                   last_episode_at desc nulls last limit 20`,
  },
  {
    // `db/podcasts/episodes.ts` — `searchEpisodeRows`, through the GIN index
    // plus the full public playability gate.
    name: 'searchEpisodes',
    sql: `select * from episodes
          where status = 'ready'
            and exists (select 1 from podcasts
                        where podcasts.id = episodes.podcast_id and podcasts.status = 'active')
            and (source = 'syra' or (enclosure_url is not null and enclosure_url <> ''))
            and search_vector @@ websearch_to_tsquery('english', 'zebra')
          order by popularity desc nulls last, pub_date desc nulls last limit 20`,
  },
  {
    /**
     * `db/podcasts/podcasts.ts` — `countSearchPodcasts`, and the probe the GIN
     * assertion actually rests on. See the "What it found" note: with no
     * `ORDER BY` there is no ordering index to compete with, so the plan is
     * stable.
     */
    name: 'countSearchPodcasts',
    alsoAtDefaultCosting: true,
    sql: `select count(*) from podcasts
          where status = 'active' and search_vector @@ websearch_to_tsquery('english', 'zebra')`,
  },
  {
    /**
     * The GIN reachability probe, and the `status` filter is deliberately NOT
     * on it.
     *
     * Three partial indexes on `podcasts` are predicated on `status = 'active'`,
     * so as long as the query carries that filter the planner has a second
     * indexed way to answer it — scan the partial index, apply the tsquery as a
     * filter — at a cost close enough that it alternates. Measured: the
     * `status`-carrying count probe passed 20/20 standalone and failed both
     * full-suite runs, purely on statistics the rest of the suite leaves behind.
     *
     * Dropping `status` removes the competitor and leaves exactly one indexable
     * condition, which is the property this file is meant to prove about the
     * schema: `podcasts_search_gin` EXISTS and is REACHABLE for a `search_vector
     * @@ tsquery` predicate. Whether the planner prefers it once a partial index
     * is also applicable is a costing question, not a reachability one, and the
     * ordered probes below assert only that neither answer is a table scan.
     */
    name: 'ginReachablePodcasts',
    alsoAtDefaultCosting: true,
    sql: `select count(*) from podcasts
          where search_vector @@ websearch_to_tsquery('english', 'zebra')`,
  },
  {
    name: 'ginReachableEpisodes',
    alsoAtDefaultCosting: true,
    sql: `select count(*) from episodes
          where search_vector @@ websearch_to_tsquery('english', 'zebra')`,
  },
  {
    // `db/podcasts/episodes.ts` — `countSearchEpisodes`, same reasoning.
    name: 'countSearchEpisodes',
    alsoAtDefaultCosting: true,
    sql: `select count(*) from episodes
          where status = 'ready'
            and exists (select 1 from podcasts
                        where podcasts.id = episodes.podcast_id and podcasts.status = 'active')
            and (source = 'syra' or (enclosure_url is not null and enclosure_url <> ''))
            and search_vector @@ websearch_to_tsquery('english', 'zebra')`,
  },
  {
    // `db/podcasts/podcasts.ts` — `findPodcastsByOwner`, the creator dashboard.
    name: 'myPodcasts',
    sql: `select * from podcasts where owner_oxy_user_id = '${MARKER}-u-7'
          order by created_at desc nulls last`,
  },
  {
    // `db/podcasts/podcasts.ts` — `findRefreshCandidates`, the scheduler batch.
    name: 'refreshCandidates',
    sql: `select feed_url, last_refreshed_at, refresh_interval_min from podcasts
          where source = 'rss' and status = 'active'
          order by subscriber_count desc nulls last, popularity desc nulls last limit 50`,
  },
  {
    // `db/podcasts/podcasts.ts` — `findHiddenShowIds`, the negation none of the
    // three partial `status = 'active'` indexes can serve.
    name: 'hiddenShows',
    sql: `select id from podcasts where status <> 'active'`,
  },
  {
    // `db/podcasts/episodes.ts` — `findEpisodesByShow`, both the owner's view
    // (no status condition) and the public one.
    name: 'showEpisodes',
    // The OWNER's view: `episodeVisibilityFilter` returns `undefined`, so the
    // statement carries no status condition at all.
    sql: () => showEpisodesSql(SEEDED_SHOW_OWNER),
  },
  {
    name: 'showEpisodesPublic',
    // A STRANGER's view, from the same function: `status = 'ready'`.
    sql: () => showEpisodesSql('someone-else'),
  },
  {
    // `db/podcasts/episodes.ts` — `episodeStats`' newest-episode read. The one
    // that replaced `max(pub_date)`; see that function's comment.
    name: 'newestEpisode',
    sql: `select pub_date from episodes where podcast_id = '${MARKER}-s-7'
          order by pub_date desc nulls last limit 1`,
  },
  {
    // `db/podcasts/episodes.ts` — `episodeExists`, once per feed item on every
    // crawl, so it has to be a point lookup.
    name: 'episodeByGuid',
    sql: `select id from episodes where podcast_id = '${MARKER}-s-7' and guid = '${MARKER}-guid-7' limit 1`,
  },
  {
    // `db/podcasts/persons.ts` — `podcastCreditsPerson`, tier 1.
    name: 'showsCreditingPerson',
    sql: `select * from podcasts
          where exists (select 1 from podcast_persons
                        where podcast_id = podcasts.id and linked_oxy_user_id = '${MARKER}-oxy-7')
            and status <> 'removed'
          order by popularity desc nulls last, last_episode_at desc nulls last limit 50`,
  },
  {
    // `db/podcasts/persons.ts` — `episodeCreditsPerson`, tier 1.
    name: 'episodesCreditingPerson',
    sql: `select * from episodes
          where exists (select 1 from episode_persons
                        where episode_id = episodes.id and linked_oxy_user_id = '${MARKER}-oxy-7')
            and status = 'ready'
          order by pub_date desc nulls last limit 50`,
  },
  {
    // `db/podcasts/subscriptions.ts` — `listSubscribedPodcastIds`.
    name: 'subscriptions',
    sql: `select podcast_id from user_podcast_subscriptions
          where oxy_user_id = '${MARKER}-u-7' order by created_at asc`,
  },
  {
    /**
     * `db/podcasts/subscriptions.ts` — `listSubscriberIds`, the REVERSE
     * direction. The one read `unique(oxy_user_id, podcast_id)` cannot serve,
     * and the reason `user_podcast_subscriptions_podcast_id_idx` exists.
     */
    name: 'subscribers',
    sql: `select oxy_user_id from user_podcast_subscriptions where podcast_id = '${MARKER}-s-7'`,
  },
  {
    // `db/podcasts/episodes.ts` — `listContinueListening`, against the partial
    // index on `completed = false`.
    name: 'continueListening',
    sql: `select episode_id, position_sec, duration_sec, completed from episode_progress
          where oxy_user_id = '${MARKER}-u-7' and completed = false
          order by updated_at desc nulls last limit 20`,
  },
  {
    // `db/podcasts/hydrate.ts` — the child-collection batch loads, one shape
    // for all six. `podcast_funding` stands in for its five siblings, which
    // carry the identical `unique(parent_id, position)`.
    name: 'childByParent',
    sql: `select * from podcast_funding where podcast_id in ('${MARKER}-s-7', '${MARKER}-s-8')
          order by "position" asc`,
  },
  {
    /**
     * The control. `podcasts.link` carries no index of its own — the GIN index
     * is on `search_vector`, which an equality on `link` cannot use — so this
     * MUST still report a Seq Scan under `enable_seqscan = off`.
     */
    name: 'control',
    sql: `select id from podcasts where link = 'nothing matches this'`,
  },
];

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function seed(tx: Tx): Promise<void> {
  await executeRows(tx, sql.raw(`
    insert into genres (id, name, kind)
    select '${MARKER}-g-' || g, '${MARKER} Category ' || g, 'podcast'
    from generate_series(1, 40) g`));

  /**
   * One show in 50 is not `active`, and one in 7 has no `last_episode_at`.
   *
   * Both proportions are load-bearing. A seed where every show is active cannot
   * tell a partial `WHERE status = 'active'` index that serves the browse from
   * one that cannot, and cannot exercise `hiddenShows` at all. A seed with no
   * NULL `last_episode_at` cannot tell `DESC NULLS LAST` from `DESC` — the two
   * orderings agree when the column has no nulls, which is exactly the fixture
   * shape that would let the rejected spelling pass.
   */
  await executeRows(tx, sql.raw(`
    insert into podcasts (id, title, author, source, status, popularity, subscriber_count,
                          last_episode_at, last_refreshed_at, owner_oxy_user_id, feed_url)
    select '${MARKER}-s-' || g,
           case when g % 251 = 0 then '${MARKER} Zebra Show ' || g else '${MARKER} Show ' || g end,
           'Author ' || g,
           case when g % 5 = 0 then 'syra' else 'rss' end,
           case when g % 50 = 0 then 'unavailable' else 'active' end,
           g % 101, g % 997,
           case when g % 7 = 0 then null else now() - (g || ' hours')::interval end,
           case when g % 11 = 0 then null else now() - (g || ' hours')::interval end,
           '${MARKER}-u-' || (1 + (g % ${SEEDED_USERS})),
           'https://feeds.example/${MARKER}/' || g || '.xml'
    from generate_series(1, ${SEEDED_SHOWS}) g`));

  await executeRows(tx, sql.raw(`
    insert into podcast_categories (id, podcast_id, genre_id, "position", kind)
    select '${MARKER}-pc-' || g, '${MARKER}-s-' || g, '${MARKER}-g-' || (1 + (g % 40)), 0, 'podcast'
    from generate_series(1, ${SEEDED_SHOWS}) g`));

  await executeRows(tx, sql.raw(`
    insert into podcast_funding (id, podcast_id, "position", url, message)
    select '${MARKER}-pf-' || g, '${MARKER}-s-' || (1 + (g % ${SEEDED_SHOWS})),
           g / ${SEEDED_SHOWS}, 'https://fund.example/' || g, null
    from generate_series(0, 9999) g`));

  /**
   * Credits: one show in 20 and one episode in 40 carry an Oxy-linked host, so
   * the `EXISTS` has both matching and non-matching parents to discriminate.
   */
  await executeRows(tx, sql.raw(`
    insert into podcast_persons (id, podcast_id, "position", name, linked_oxy_user_id)
    select '${MARKER}-pp-' || g, '${MARKER}-s-' || g, 0, 'Host ' || g,
           '${MARKER}-oxy-' || (1 + (g % 20))
    from generate_series(1, ${SEEDED_SHOWS}) g`));

  /**
   * One episode in 17 is not `ready` and one in 29 is an RSS episode with NO
   * enclosure — coprime, so all four combinations of the public playability
   * gate occur. A seed where every episode is playable cannot tell the gate
   * from its absence.
   */
  await executeRows(tx, sql.raw(`
    insert into episodes (id, podcast_id, podcast_title, title, guid, pub_date, source,
                          enclosure_url, status, popularity)
    select '${MARKER}-e-' || g, '${MARKER}-s-' || (1 + (g % ${SEEDED_SHOWS})),
           'Show',
           case when g % 1009 = 0 then '${MARKER} Zebra Episode ' || g
                else '${MARKER} Episode ' || g end,
           '${MARKER}-guid-' || g,
           now() - (g || ' minutes')::interval,
           case when g % 6 = 0 then 'syra' else 'rss' end,
           case when g % 29 = 0 then null else 'https://cdn.example/' || g || '.mp3' end,
           case when g % 17 = 0 then 'processing' else 'ready' end,
           g % 101
    from generate_series(1, ${SEEDED_EPISODES}) g`));

  await executeRows(tx, sql.raw(`
    insert into episode_persons (id, episode_id, "position", name, linked_oxy_user_id)
    select '${MARKER}-ep-' || g, '${MARKER}-e-' || g, 0, 'Guest ' || g,
           '${MARKER}-oxy-' || (1 + (g % 40))
    from generate_series(1, ${SEEDED_EPISODES}) g`));

  /**
   * A PRIME modulus for the user index, the same trap `library.explain.test.ts`
   * records: with `(g % 2000, g % 5000)` the pair repeats every 10,000 rows and
   * the seed dies on `user_podcast_subscriptions_oxy_user_id_podcast_id_key`.
   */
  await executeRows(tx, sql.raw(`
    insert into user_podcast_subscriptions (id, oxy_user_id, podcast_id, created_at)
    select '${MARKER}-ups-' || g, '${MARKER}-u-' || (1 + ((g * 3) % 1999)),
           '${MARKER}-s-' || (1 + (g % ${SEEDED_SHOWS})), now() - (g || ' seconds')::interval
    from generate_series(1, 20000) g`));

  // Same prime-modulus reason, against
  // `episode_progress_oxy_user_id_episode_id_key`. One row in three is
  // completed, so the partial index has rows on both sides of its predicate.
  await executeRows(tx, sql.raw(`
    insert into episode_progress (id, oxy_user_id, episode_id, position_sec, duration_sec,
                                  completed, updated_at)
    select '${MARKER}-prg-' || g, '${MARKER}-u-' || (1 + ((g * 3) % 1999)),
           '${MARKER}-e-' || (1 + (g % ${SEEDED_EPISODES})), 30, 1800,
           case when g % 3 = 0 then true else false end,
           now() - (g || ' seconds')::interval
    from generate_series(1, 30000) g`));

  await executeRows(tx, sql.raw(
    'analyze genres, podcasts, podcast_categories, podcast_funding, podcast_persons, ' +
    'episodes, episode_persons, user_podcast_subscriptions, episode_progress'
  ));

  const [shows] = await executeRows<{ total: number }>(
    tx, sql.raw(`select count(*)::int as total from podcasts where id like '${MARKER}-%'`));
  seededShowCount = shows?.total ?? 0;

  const [eps] = await executeRows<{ total: number }>(
    tx, sql.raw(`select count(*)::int as total from episodes where id like '${MARKER}-%'`));
  seededEpisodeCount = eps?.total ?? 0;
}

beforeAll(async () => {
  await connectUnmanagedDb();

  try {
    await getDb().transaction(async (tx) => {
      await seed(tx);

      /**
       * TWO passes, and the second one is not redundant.
       *
       * `enable_seqscan = off` is what makes "a remaining Seq Scan means no
       * index could serve this" a valid reading — but it ALSO makes every index
       * on the table a viable full-scan substitute, so for a predicate whose
       * only real index is the GIN the planner can pick an ordering index with
       * the tsquery as a filter at essentially the same cost. Measured: the
       * `countSearchPodcasts` probe alternated between `podcasts_search_gin` and
       * `podcasts_active_last_episode_at_idx` across runs.
       *
       * So "no Seq Scan" is read from the first pass, and "the GIN is what the
       * planner actually WANTS" is read from the second, at DEFAULT costing,
       * where an ordering-index full scan has to beat a plain sequential scan to
       * be chosen and does not. Both readings are needed; neither substitutes
       * for the other.
       */
      await executeRows(tx, sql.raw('set local enable_seqscan = off'));

      for (const probe of PROBES) {
        const statement = typeof probe.sql === 'function' ? probe.sql() : probe.sql;
        const rows = await executeRows<{ 'QUERY PLAN': string }>(
          tx, sql.raw(`explain (analyze, buffers) ${statement}`));
        plans.set(probe.name, rows.map((row) => row['QUERY PLAN']).join('\n'));
      }

      await executeRows(tx, sql.raw('set local enable_seqscan = on'));

      for (const probe of PROBES.filter((candidate) => candidate.alsoAtDefaultCosting)) {
        const statement = typeof probe.sql === 'function' ? probe.sql() : probe.sql;
        const rows = await executeRows<{ 'QUERY PLAN': string }>(
          tx, sql.raw(`explain (analyze, buffers) ${statement}`));
        plans.set(`${probe.name}:default`, rows.map((row) => row['QUERY PLAN']).join('\n'));
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
    expect(seededShowCount).toBe(SEEDED_SHOWS);
    expect(seededEpisodeCount).toBe(SEEDED_EPISODES);
  });

  it('the control still reports a table scan under enable_seqscan = off', () => {
    expect(plans.get('control')).toContain('Seq Scan on podcasts');
  });
});

describe('the browse shelf reaches an index', () => {
  it('the popular sort reads the partial popularity index', () => {
    expect(plans.get('browsePopular')).not.toContain('Seq Scan on podcasts');
    expect(`browse popular: ${indexesIn('browsePopular')}`).toBe(
      'browse popular: podcasts_active_popularity_idx'
    );
  });

  it('the recent sort reads the partial last-episode index', () => {
    expect(plans.get('browseRecent')).not.toContain('Seq Scan on podcasts');
    expect(`browse recent: ${indexesIn('browseRecent')}`).toBe(
      'browse recent: podcasts_active_last_episode_at_idx'
    );
  });

  /**
   * The counterpart measurement. Without this, "descNullsLast uses the index"
   * could equally mean the planner would have used it for any spelling, and the
   * convention would be unjustified.
   */
  it('plain DESC — NULLS FIRST — has to sort every matching row', () => {
    const rejected = plans.get('browseRecentNullsFirst') ?? '';
    const shipped = plans.get('browseRecent') ?? '';
    // Both reach the index; only the shipped spelling STREAMS it. The `Sort`
    // node is the difference, and it is what makes the cost a function of the
    // result set rather than of the page.
    expect(rejected).toContain('Sort Key: last_episode_at DESC');
    expect(shipped).not.toContain('Sort Key:');
  });

  it('the category filter reaches both the genre name and the junction', () => {
    expect(plans.get('genreByName')).not.toContain('Seq Scan on genres');
    expect(`genre by name: ${indexesIn('genreByName')}`).toBe(
      'genre by name: genres_lower_name_kind_key'
    );
    expect(plans.get('browseCategory')).not.toContain('Seq Scan on podcast_categories');
  });
});

describe('the search reads reach the GIN indexes', () => {
  /**
   * The GIN assertion rests on the COUNT queries, not the ordered list ones,
   * and that split is the point rather than a workaround.
   *
   * For the ORDERED query the planner has two indexed plans within ~0.1% of
   * each other — a GIN bitmap plus a quicksort of the 19 matches (cost 412.04),
   * or a scan of `podcasts_active_popularity_idx` filtering on the tsquery —
   * and it genuinely alternates between them. Measured: three consecutive runs
   * of this file gave GIN, ordering index, ordering index. BOTH are correct and
   * both are indexed, so a gate demanding one of them is not measuring
   * reachability, it is measuring a coin flip — and a gate that cries wolf gets
   * disabled by whoever hits it next.
   *
   * It rests instead on `ginReachablePodcasts`/`ginReachableEpisodes`, which
   * carry ONLY the tsquery — no `status` filter. Three partial indexes on
   * `podcasts` are predicated on `status = 'active'`, so any query carrying that
   * filter has a second indexed answer available and the choice between them is
   * a costing coin flip; a probe with no competitor has exactly one applicable
   * index, which is the schema property this file exists to prove. Everything
   * else — the shipped counts and the ordered lists — keeps the weaker, stable
   * property that it does not fall to a table scan.
   */
  /**
   * Read from the `enable_seqscan = off` pass, on the probe with no competing
   * partial index: exactly one indexable condition, exactly one index that can
   * serve it, so the answer is unambiguous rather than a costing preference.
   *
   * NOT from the default-costing pass, and the measurement is worth keeping:
   * over 5,000 shows a sequential scan costs 261.50 while the GIN bitmap's
   * index scan alone costs 352.92, so at this size Postgres correctly prefers
   * the scan. That is the stemming-and-GIN argument playing out rather than
   * failing — the GIN's cost is a function of MATCHES and the scan's of
   * CATALOGUE SIZE, so the crossover is ahead of a 5,000-row seed, not behind
   * it. Seeding past the crossover would make this file minutes long to prove
   * something `enable_seqscan = off` answers directly.
   */
  it('podcasts_search_gin is reachable for a tsquery predicate', () => {
    expect(plans.get('ginReachablePodcasts')).not.toContain('Seq Scan on podcasts');
    expect(`podcast gin: ${indexesIn('ginReachablePodcasts')}`).toBe(
      'podcast gin: podcasts_search_gin'
    );
  });

  it('episodes_search_gin is reachable for a tsquery predicate', () => {
    expect(plans.get('ginReachableEpisodes')).not.toContain('Seq Scan on episodes');
    expect(`episode gin: ${indexesIn('ginReachableEpisodes')}`).toBe(
      'episode gin: episodes_search_gin'
    );
  });

  it('the search COUNT queries reach an index either way', () => {
    // The shipped counts carry the visibility filter, so a partial index is
    // also applicable and the planner may pick either. What must not happen is
    // a table scan.
    expect(plans.get('countSearchPodcasts')).not.toContain('Seq Scan on podcasts');
    expect(plans.get('countSearchEpisodes')).not.toContain('Seq Scan on episodes');
  });

  it('the ordered podcast search reaches an index either way', () => {
    const plan = plans.get('searchPodcasts') ?? '';
    expect(plan).not.toContain('Seq Scan on podcasts');
    // Whichever of the two plans the planner picked, it picked an index.
    expect(`podcast search index count: ${indexesIn('searchPodcasts').length > 0}`).toBe(
      'podcast search index count: true'
    );
  });

  it('the ordered episode search reaches an index, and the show gate is a probe', () => {
    expect(plans.get('searchEpisodes')).not.toContain('Seq Scan on episodes');
    expect(`episode search index count: ${indexesIn('searchEpisodes').length > 0}`).toBe(
      'episode search index count: true'
    );
    // The hidden-show semi-join resolves against the primary key, one probe per
    // candidate — the whole argument for replacing the Mongo form's separate
    // "which shows are hidden" query and its unbounded `$nin` list.
    expect(plans.get('searchEpisodes')).not.toContain('Seq Scan on podcasts');
  });
});

describe('the creator and scheduler reads reach an index', () => {
  it('a creator\'s own shows come from the owner index', () => {
    expect(plans.get('myPodcasts')).not.toContain('Seq Scan on podcasts');
    expect(`my podcasts: ${indexesIn('myPodcasts')}`).toBe(
      'my podcasts: podcasts_owner_oxy_user_id_created_at_idx'
    );
  });

  it('the refresh batch reads its own compound partial index', () => {
    expect(plans.get('refreshCandidates')).not.toContain('Seq Scan on podcasts');
    expect(`refresh batch: ${indexesIn('refreshCandidates')}`).toBe(
      'refresh batch: podcasts_rss_active_subscriber_count_idx'
    );
  });

  /**
   * The NEGATION. None of the three partial `status = 'active'` indexes can
   * serve `status <> 'active'`, which is why `podcasts_inactive_idx` exists at
   * all — see its comment in `schema/podcasts.ts`.
   */
  it('the hidden-show set reads the inactive index, not any active one', () => {
    expect(plans.get('hiddenShows')).not.toContain('Seq Scan on podcasts');
    expect(`hidden shows: ${indexesIn('hiddenShows')}`).toBe('hidden shows: podcasts_inactive_idx');
  });
});

describe('the episode reads reach an index', () => {
  /**
   * Asserted on the index PREFIX, not on one name, and for the same reason the
   * GIN assertions moved to the count queries: `episodes_podcast_id_pub_date_idx`
   * and `episodes_podcast_id_guid_key` both lead with `podcast_id`, so both can
   * serve the filter, and the planner alternates between them (the guid index
   * plus a sort of the show's episodes costs about the same as streaming the
   * ordered one). Five runs gave `guid_key` five times where an earlier version
   * of this file demanded `pub_date_idx`.
   *
   * That reasoning is unchanged and still right; only the SHAPE of the check is
   * tightened. It was `toContain('episodes_podcast_id_')`, which asks whether an
   * acceptable index appears anywhere in the plan — so a plan that reached one
   * of these two AND ALSO scanned `episodes_ready_popularity_idx` passed, even
   * though that second index is precisely what the prefix was chosen to exclude.
   * Naming the two acceptable indexes as a set asks the other question — is
   * there anything here I did not expect — while keeping the alternation the
   * comment above describes.
   *
   * The NON-partial index is the point of the second probe: a `status =
   * 'ready'` partial index would stop serving the owner's own
   * unpublished-episode view, which is the first probe.
   */
  const SHOW_EPISODE_INDEXES = [
    'episodes_podcast_id_pub_date_idx',
    'episodes_podcast_id_guid_key',
  ];

  it('a show\'s episodes are filtered through an index on the show, for both viewers', () => {
    expect(plans.get('showEpisodes')).not.toContain('Seq Scan on episodes');
    expectIndexesWithin('owner view', indexesIn('showEpisodes'), SHOW_EPISODE_INDEXES);
    expect(plans.get('showEpisodesPublic')).not.toContain('Seq Scan on episodes');
    expectIndexesWithin('public view', indexesIn('showEpisodesPublic'), SHOW_EPISODE_INDEXES);
  });

  /**
   * The assertion that makes BINDING these two probes worth anything.
   *
   * Binding was measured to work: reverting the module's `descNullsLast` to a
   * plain `desc()` changed the probe's plan from `Sort Key: pub_date DESC NULLS
   * LAST` to `Sort Key: pub_date DESC`, because the probe now renders the
   * shipped builder. And every assertion above still PASSED — the index checks
   * cannot see an ordering change, since `enable_seqscan = off` keeps the
   * planner on the same index either way and it simply sorts.
   *
   * So a bound probe with an ordering-blind assertion is a transcription with
   * extra steps. This is the sensitive half.
   *
   * At this seed size — one show, eight episodes — BOTH spellings sort, so the
   * discriminator is the sort key's text rather than sorted-versus-streamed.
   * `browseRecentNullsFirst` above covers the streamed case at 4,900 rows, where
   * the difference is the whole page against the whole result set.
   */
  it('both viewers order by the spelling the index can serve', () => {
    for (const probe of ['showEpisodes', 'showEpisodesPublic']) {
      expect(`${probe}: ${plans.get(probe)?.includes('Sort Key: pub_date DESC NULLS LAST')}`)
        .toBe(`${probe}: true`);
    }
  });

  it('the newest episode is one row off the ordered index, not an aggregate', () => {
    const plan = plans.get('newestEpisode') ?? '';
    expect(plan).not.toContain('Seq Scan on episodes');
    expect(`newest episode: ${indexesIn('newestEpisode')}`).toBe(
      'newest episode: episodes_podcast_id_pub_date_idx'
    );
    // Named rather than merely implied: the point of replacing `max(pub_date)`
    // was the driver mapping, and this is what says the replacement did not
    // cost a scan to get it.
    expect(plan).not.toContain('Aggregate');
  });

  it('the per-item existence check is a point lookup on the unique index', () => {
    expect(plans.get('episodeByGuid')).not.toContain('Seq Scan on episodes');
    expect(`episode by guid: ${indexesIn('episodeByGuid')}`).toBe(
      'episode by guid: episodes_podcast_id_guid_key'
    );
  });
});

describe('the appears-in shelf reaches the credit indexes', () => {
  it('shows crediting a person come through podcast_persons_linked_oxy_user_id_idx', () => {
    expect(plans.get('showsCreditingPerson')).not.toContain('Seq Scan on podcast_persons');
    expect(`show credits: ${indexesIn('showsCreditingPerson')}`).toContain(
      'podcast_persons_linked_oxy_user_id_idx'
    );
  });

  it('episodes crediting a person come through episode_persons_linked_oxy_user_id_idx', () => {
    expect(plans.get('episodesCreditingPerson')).not.toContain('Seq Scan on episode_persons');
    expect(`episode credits: ${indexesIn('episodesCreditingPerson')}`).toContain(
      'episode_persons_linked_oxy_user_id_idx'
    );
  });
});

describe('the subscription reads reach an index in BOTH directions', () => {
  it('a user\'s subscriptions read the unique index', () => {
    expect(plans.get('subscriptions')).not.toContain('Seq Scan on user_podcast_subscriptions');
    expect(`subscriptions: ${indexesIn('subscriptions')}`).toBe(
      'subscriptions: user_podcast_subscriptions_oxy_user_id_podcast_id_key'
    );
  });

  /**
   * The reverse read, which the unique index CANNOT serve — it leads with
   * `oxy_user_id`. This is the episode-published fan-out, and the only reason
   * `user_podcast_subscriptions_podcast_id_idx` exists; asserting the index by
   * NAME is what makes that claim checkable rather than decorative.
   */
  it('a show\'s subscribers read the podcast_id index, not the unique one', () => {
    expect(plans.get('subscribers')).not.toContain('Seq Scan on user_podcast_subscriptions');
    expect(`subscribers: ${indexesIn('subscribers')}`).toBe(
      'subscribers: user_podcast_subscriptions_podcast_id_idx'
    );
  });
});

describe('the resume surface and the child loads reach an index', () => {
  it('continue-listening reads the partial completed = false index', () => {
    expect(plans.get('continueListening')).not.toContain('Seq Scan on episode_progress');
    expect(`continue listening: ${indexesIn('continueListening')}`).toBe(
      'continue listening: episode_progress_oxy_user_id_updated_at_idx'
    );
  });

  it('a child collection loads by parent id without scanning its table', () => {
    expect(plans.get('childByParent')).not.toContain('Seq Scan on podcast_funding');
    expectIndexesWithin('child by parent', indexesIn('childByParent'), [
      'podcast_funding_podcast_id_position_key',
    ]);
  });
});
