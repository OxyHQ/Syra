/**
 * Episodes — every read and write of `episodes`, its three child tables, and
 * `episode_progress`.
 *
 * Same transaction discipline as `podcasts.ts`, and one thing that module does
 * not have to solve: the import path needs to know whether a per-episode upsert
 * INSERTED or UPDATED, because only a genuine insert is a new episode worth
 * notifying subscribers about. Mongo answered it with
 * `lastErrorObject.updatedExisting`; here it is {@link INSERTED}, `xmax = 0` on
 * the returned row — see that constant's comment.
 *
 * ## `updated_at` has to be written by hand on an upsert
 *
 * `@oxyhq/db`'s `updatedAt()` carries `$onUpdate(() => new Date())`, which
 * drizzle applies to `.update()` — and NOT to the `set` of an
 * `onConflictDoUpdate`. Mongo's `timestamps: true` moved it on every
 * `findOneAndUpdate`, upsert included. So every conflict path below sets it
 * explicitly. This is not cosmetic: `episode_progress.updated_at` is the sort
 * key of "continue listening", and an upsert that left it alone would freeze a
 * listener's resume list in whatever order it was first built.
 */

import {
  and,
  count,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { EpisodePerson, EpisodeTranscript, HlsRendition } from '@syra/shared-types';
import { getDb, type DbOrTransaction } from '../postgres';
import { episodeProgress, episodes, podcasts } from '../schema/podcasts';
import { descNullsLast } from '../catalog/containers';
import { textSearch } from '../catalog/search';
import { setEpisodeHlsRenditions, setEpisodePersons, setEpisodeTranscripts } from './children';
import { episodeCreditsPerson, type CreditIdentity } from './persons';
import { publiclyPlayableEpisodeFilter, showIsReadableByViewer } from './visibility';
import type { EpisodeRow, PodcastRow } from './serialize';

/**
 * "This returned row was inserted, not updated."
 *
 * `xmax` is the transaction id that deleted or locked a row; for a freshly
 * INSERTED row it is 0, and for the update half of an `ON CONFLICT DO UPDATE`
 * it carries the current transaction. It is a system column on every table, it
 * needs no extra round trip, and it is exact under concurrency in a way the
 * alternative — reading the row first and inferring — is not.
 */
const INSERTED = sql<boolean>`(xmax = 0)`;

/** The columns a caller may write on `episodes`. */
export type EpisodeValues = Partial<Omit<typeof episodes.$inferInsert, 'id' | 'searchVector'>>;

/** The child collections an episode write may replace; `undefined` leaves alone. */
export interface EpisodeChildValues {
  readonly transcripts?: readonly EpisodeTranscript[];
  readonly persons?: readonly EpisodePerson[];
  readonly hls?: readonly HlsRendition[];
}

async function writeChildren(
  tx: DbOrTransaction,
  episodeId: string,
  children: EpisodeChildValues
): Promise<void> {
  if (children.transcripts !== undefined) {
    await setEpisodeTranscripts(tx, episodeId, children.transcripts);
  }
  if (children.persons !== undefined) await setEpisodePersons(tx, episodeId, children.persons);
  if (children.hls !== undefined) await setEpisodeHlsRenditions(tx, episodeId, children.hls);
}

function definedOnly<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** An episode and the show it belongs to — see {@link findEpisodeById}. */
export interface EpisodeWithShow {
  readonly episode: EpisodeRow;
  readonly show: PodcastRow;
}

/**
 * One episode AND its parent show, always together.
 *
 * The join is the access control, not an optimisation. Every rule about who may
 * see an episode lives on the SHOW — visibility, the publish state, the owner —
 * so a caller holding only an episode row cannot answer any of them and, before
 * this returned a pair, three handlers simply did not
 * (`GET /api/episodes/:id`, `/key`, `/audio`): a show takedown never reached
 * episode detail, and the AES-128 key was handed to any signed-in caller for any
 * id. Returning the show beside the episode makes the unguarded read
 * unspellable rather than merely discouraged.
 *
 * An `INNER JOIN` and not a left one: `episodes.podcast_id` is `NOT NULL
 * REFERENCES podcasts(id) ON DELETE CASCADE`, so an episode with no show is not
 * representable and a `LEFT JOIN` would only add an impossible `null` branch for
 * every caller to handle.
 *
 * Deliberately UNFILTERED by viewer: it is the loader for handlers that then
 * apply their own rule (a public `/audio` fetch, an owner's edit, the ingest
 * job), and each of those rules is different. What it guarantees is that the
 * rule CAN be applied.
 */
export async function findEpisodeById(id: string): Promise<EpisodeWithShow | undefined> {
  const [row] = await getDb()
    .select({ episode: getTableColumns(episodes), show: getTableColumns(podcasts) })
    .from(episodes)
    .innerJoin(podcasts, eq(podcasts.id, episodes.podcastId))
    .where(eq(episodes.id, id))
    .limit(1);
  return row;
}

/**
 * Episodes by id, for a given viewer — the resume list's hydration read.
 *
 * The show gate is the change: this used to test the EPISODE's own status and
 * nothing else, so an episode of a show that had gone private kept resolving for
 * anyone who had ever played it. Now the show must be readable by this viewer
 * (`showIsReadableByViewer`: reachable, or theirs).
 *
 * The consequence is intended and visible to listeners: a "continue listening"
 * entry for a show that went private DISAPPEARS from their list. The
 * `episode_progress` row is untouched, so it returns if the show does.
 */
export async function findEpisodesByIds(
  ids: readonly string[],
  viewerId: string | null | undefined
): Promise<EpisodeRow[]> {
  if (ids.length === 0) return [];
  return getDb()
    .select()
    .from(episodes)
    .where(
      and(
        inArray(episodes.id, [...ids]),
        ne(episodes.status, 'unavailable'),
        showIsReadableByViewer(viewerId)
      )
    );
}

/**
 * One show's episodes, in the order a NUMBERED SERIES needs.
 *
 * `episode_number desc nulls last, pub_date desc nulls last`, not `pub_date`
 * alone. A serial show's episodes are identified by their number, and their
 * publish dates routinely disagree with it — a back-catalogue import stamps a
 * crawl time, a re-upload moves it, and two episodes released in one drop share
 * a date entirely. Ordering by date alone therefore showed a numbered show
 * scrambled, with nothing on the screen explaining why.
 *
 * `NULLS LAST` on the number is what keeps this correct for the shows that do
 * NOT number: an unnumbered episode sorts after every numbered one and then
 * among its own kind by date, so a show with no numbers at all is byte-for-byte
 * the old ordering. A show that numbers only some of its episodes gets the
 * numbered ones first, which is the only answer that does not interleave two
 * incomparable schemes.
 *
 * `visibility` is `episodeVisibilityFilter`'s output — `undefined` for the
 * show's owner, who sees every status. Served by
 * `episodes_podcast_id_episode_number_pub_date_idx`, which `schema/podcasts.ts`
 * keeps NON-partial for exactly the reason its `pub_date` sibling is: a
 * `status = 'ready'` partial index would silently stop serving the owner's own
 * unpublished-episode view.
 */
export function episodesByShowQuery(
  podcastId: string,
  options: { visibility: SQL | undefined; offset?: number; limit: number }
) {
  return getDb()
    .select()
    .from(episodes)
    .where(and(eq(episodes.podcastId, podcastId), options.visibility))
    .orderBy(descNullsLast(episodes.episodeNumber), descNullsLast(episodes.pubDate))
    .offset(options.offset ?? 0)
    .limit(options.limit);
}

/**
 * Split from {@link episodesByShowQuery} so the EXPLAIN probe measures the
 * SHIPPED statement instead of a paraphrase of it.
 *
 * `db/podcasts/__tests__/podcasts.explain.test.ts` renders that builder with
 * `.toSQL()`. The alternative — the probe re-typing the `where`/`orderBy` — is
 * what every other probe in that family still does, and it means a change here
 * leaves the probe measuring the OLD shape while still passing. That is not
 * hypothetical for this query in particular: the ordering is the thing under
 * test (`descNullsLast` streams `episodes_podcast_id_pub_date_idx`, a plain
 * `desc()` is `NULLS FIRST` and cannot), so a transcription that keeps the old
 * spelling certifies a plan the module no longer produces.
 *
 * Nothing else about the query changed; this returns exactly what the body
 * above used to build, which is why the measured plan is unchanged.
 */
export async function findEpisodesByShow(
  podcastId: string,
  options: { visibility: SQL | undefined; offset?: number; limit: number }
): Promise<EpisodeRow[]> {
  return episodesByShowQuery(podcastId, options);
}

export async function countEpisodesByShow(
  podcastId: string,
  visibility: SQL | undefined
): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(episodes)
    .where(and(eq(episodes.podcastId, podcastId), visibility));
  return row?.total ?? 0;
}

/**
 * Every READY episode of a show, for the generated public RSS feed.
 *
 * `status = 'ready'`, not `<> 'unavailable'`. The negation admitted `processing`
 * and `failed` episodes, so a creator's still-transcoding upload — and one whose
 * ingest had failed outright, with no playable media at all — was published into
 * a feed that Apple Podcasts, Overcast and Podcast Index fetch anonymously. Both
 * are exactly the states `episodeVisibilityFilter` withholds from a non-owner on
 * every other surface; the feed is the surface that had never been told.
 */
export async function findFeedEpisodes(podcastId: string, limit: number): Promise<EpisodeRow[]> {
  return getDb()
    .select()
    .from(episodes)
    .where(and(eq(episodes.podcastId, podcastId), eq(episodes.status, 'ready')))
    .orderBy(descNullsLast(episodes.pubDate))
    .limit(limit);
}

/**
 * How many READY episodes each of these shows has.
 *
 * `podcasts.episode_count` is a stored counter over EVERY episode, `processing`
 * and `failed` included (`insertEpisode`'s `recordOnShow` bumps it the moment an
 * upload lands, and `episodeStats` recomputes it from all rows), so serving it
 * to a stranger tells them a show has unpublished episodes and how many. This is
 * the number a non-owner is given instead — one grouped query per page, keyed on
 * `podcast_id`, never one per show.
 */
export async function countReadyEpisodesByShows(
  podcastIds: readonly string[]
): Promise<Map<string, number>> {
  if (podcastIds.length === 0) return new Map();

  const rows = await getDb()
    .select({ podcastId: episodes.podcastId, total: count() })
    .from(episodes)
    .where(and(inArray(episodes.podcastId, [...podcastIds]), eq(episodes.status, 'ready')))
    .groupBy(episodes.podcastId);

  return new Map(rows.map((row) => [row.podcastId, row.total]));
}

/**
 * The show's episode count and newest publish date — the end-of-crawl bookkeeping.
 *
 * ## Two queries, and `max()` is deliberately not one of them
 *
 * The obvious single query is `select count(*), max(pub_date)`. It is wrong here,
 * and `sql<Date | null>` on the projection is what made it LOOK right: drizzle
 * applies a column's `mapFromDriverValue` to a COLUMN, and a raw SQL expression
 * has no column to map through. Measured on this schema — the identical
 * `timestamptz` value read both ways in one process:
 *
 *   through the column   Date     2026-08-07T02:05:31.941Z
 *   through max()        string   "2026-08-07 02:05:31.941748+00"
 *
 * The generic parameter is an assertion, not a conversion, so the string typed
 * as a `Date`, flowed into `setPodcastRefreshState`, and blew up inside
 * drizzle's own `mapToDriverValue` with `value.toISOString is not a function` —
 * one layer below anything that names this module. Reading the ORDERED column
 * instead returns a real `Date`, and it is served by
 * `episodes_podcast_id_pub_date_idx` (which leads with `podcast_id` and then
 * `pub_date desc`), so it is a one-row index probe rather than an aggregate.
 *
 * It is also what Mongo did — `findOne({podcastId}).sort({pubDate:-1})` — so the
 * two-query shape is the port rather than a concession.
 */
export async function episodeStats(
  podcastId: string
): Promise<{ total: number; latestPubDate: Date | undefined }> {
  const [totals] = await getDb()
    .select({ total: count() })
    .from(episodes)
    .where(eq(episodes.podcastId, podcastId));

  const [newest] = await getDb()
    .select({ pubDate: episodes.pubDate })
    .from(episodes)
    .where(eq(episodes.podcastId, podcastId))
    .orderBy(descNullsLast(episodes.pubDate))
    .limit(1);

  return { total: totals?.total ?? 0, latestPubDate: newest?.pubDate };
}

/**
 * Syra-hosted episodes of one show that have source audio but no HLS ladder.
 *
 * The deferred-ingest set: while a show is `private` its episodes are not
 * transcoded (`services/podcasts/ingestEpisode.ts` says why), so publishing it
 * has to find the ones that were skipped. Keyed on `hls_master_key is null`
 * rather than on `status`, because `status` is also `processing` for an episode
 * whose transcode is genuinely still running and `failed` for one that tried and
 * could not — and re-running ingest for the second of those is right, while
 * distinguishing them from a deferral is not something `status` can do.
 */
export async function findEpisodeIdsAwaitingHls(podcastId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: episodes.id })
    .from(episodes)
    .where(
      and(
        eq(episodes.podcastId, podcastId),
        eq(episodes.source, 'syra'),
        isNull(episodes.hlsMasterKey),
        isNotNull(episodes.audioSourceUrl),
        ne(episodes.status, 'unavailable')
      )
    );
  return rows.map((row) => row.id);
}

export async function episodeExists(podcastId: string, guid: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: episodes.id })
    .from(episodes)
    .where(and(eq(episodes.podcastId, podcastId), eq(episodes.guid, guid)))
    .limit(1);
  return row !== undefined;
}

/**
 * Playable episodes matching a query, through the GIN-indexed `search_vector`.
 *
 * The last of the two podcast regexes. `episodes.search_vector` is
 * `to_tsvector('english', title)` — title only, matching the Mongo filter, which
 * searched `title` and nothing else.
 */
export async function searchEpisodeRows(
  query: string,
  offset: number,
  limit: number
): Promise<EpisodeRow[]> {
  return getDb()
    .select()
    .from(episodes)
    .where(and(publiclyPlayableEpisodeFilter(), textSearch(episodes.searchVector, query)))
    .orderBy(descNullsLast(episodes.popularity), descNullsLast(episodes.pubDate))
    .offset(offset)
    .limit(limit);
}

export async function countSearchEpisodes(query: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(episodes)
    .where(and(publiclyPlayableEpisodeFilter(), textSearch(episodes.searchVector, query)));
  return row?.total ?? 0;
}

/** Episodes crediting a person — the `appearsIn` shelf's episode half. */
export async function findEpisodesCreditingPerson(
  person: CreditIdentity,
  limit: number
): Promise<EpisodeRow[]> {
  return getDb()
    .select()
    .from(episodes)
    .where(and(episodeCreditsPerson(person), publiclyPlayableEpisodeFilter()))
    .orderBy(descNullsLast(episodes.pubDate))
    .limit(limit);
}

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * Insert an episode, its child collections, and — for a creator upload — the
 * parent show's counters, in ONE transaction.
 *
 * `recordOnShow` exists because `podcasts.episode_count` and `last_episode_at`
 * are DERIVED facts about the episode set, so "this episode exists" and "the
 * show has one more episode" are one fact rather than two. The Task 12 review
 * (M2) found the counter bump sitting outside this transaction as a separate
 * call: a failure between them drifted a Syra-hosted show's counters
 * permanently, because only the RSS import path recomputes them from the rows
 * (`episodeStats`). That was parity with Mongo, which had no transaction to put
 * it in; here there is one, so it goes in it.
 */
export async function insertEpisode(
  values: typeof episodes.$inferInsert,
  children: EpisodeChildValues = {},
  options: { readonly recordOnShow?: boolean } = {},
  /**
   * Join the CALLER's transaction instead of opening one.
   *
   * The draft endpoint writes an episode and its ingest ticket together: a
   * ticket whose redemption row failed to land is a capability that can never be
   * redeemed (the claim treats a missing row as refused), and an episode with no
   * ticket is a row nobody can ever attach audio to. Neither half is useful
   * alone, so neither may land alone — and that is not expressible while this
   * function insists on being the outermost transaction.
   */
  tx?: DbOrTransaction
): Promise<EpisodeRow> {
  const run = async (db: DbOrTransaction): Promise<EpisodeRow> => {
    const [row] = await db.insert(episodes).values(values).returning();
    if (!row) throw new Error('insertEpisode: insert returned no row');
    await writeChildren(db, row.id, children);

    if (options.recordOnShow) {
      await db
        .update(podcasts)
        .set({
          episodeCount: sql`${podcasts.episodeCount} + 1`,
          lastEpisodeAt: row.pubDate,
        })
        .where(eq(podcasts.id, row.podcastId));
    }

    return row;
  };

  return tx ? run(tx) : getDb().transaction(run);
}

export async function updateEpisode(
  id: string,
  values: EpisodeValues,
  children: EpisodeChildValues = {}
): Promise<EpisodeRow | undefined> {
  return getDb().transaction(async (tx) => {
    const set = definedOnly(values);
    let row: EpisodeRow | undefined;

    if (Object.keys(set).length > 0) {
      [row] = await tx.update(episodes).set(set).where(eq(episodes.id, id)).returning();
    } else {
      [row] = await tx.select().from(episodes).where(eq(episodes.id, id)).limit(1);
    }

    if (!row) return undefined;
    await writeChildren(tx, id, children);
    return row;
  });
}

/**
 * The import path's per-episode upsert, keyed on `(podcast_id, guid)`.
 *
 * Returns whether the row was newly INSERTED, which is what decides a
 * notification: `importedEpisodes` counts episodes PROCESSED and every refresh
 * re-processes the whole feed, so it cannot drive the fan-out.
 */
export async function upsertEpisodeFromFeed(input: {
  /**
   * The COMPLETE row for the insert path.
   *
   * Split from `set` rather than merged with it, because `episodes.title`,
   * `podcast_title`, `pub_date` and `source` are `NOT NULL` with no default: a
   * single `Partial` value object would let an insert missing one of them
   * type-check and fail at runtime. Mongo accepted exactly that — a
   * `findOneAndUpdate` upsert does not run validators, so a feed item with no
   * title inserted a title-less episode.
   */
  readonly insert: typeof episodes.$inferInsert;
  /** The columns a REFRESH overwrites — a subset of the insert, never a superset. */
  readonly set: EpisodeValues;
  readonly children: EpisodeChildValues;
}): Promise<{ row: EpisodeRow; inserted: boolean }> {
  return getDb().transaction(async (tx) => {
    const set = definedOnly(input.set);
    const [upserted] = await tx
      .insert(episodes)
      .values(input.insert)
      .onConflictDoUpdate({
        target: [episodes.podcastId, episodes.guid],
        // Never the insert-only half: a refresh must not reset an episode's
        // `status` (a creator may have unpublished it) or wipe its cache state.
        set: { ...set, updatedAt: new Date() },
      })
      .returning({ ...getTableColumns(episodes), inserted: INSERTED });

    if (!upserted) throw new Error(`upsertEpisodeFromFeed: no row for guid ${input.insert.guid}`);
    const { inserted, ...row } = upserted;
    await writeChildren(tx, row.id, input.children);
    return { row, inserted };
  });
}

/** `processing` → `ready` | `failed`, the ingest job's only status writes. */
export async function setEpisodeStatus(
  id: string,
  status: 'ready' | 'processing' | 'failed' | 'unavailable'
): Promise<void> {
  await getDb().update(episodes).set({ status }).where(eq(episodes.id, id));
}

/** The HLS ladder and its master key, written together when ingest succeeds. */
export async function setEpisodeHls(
  id: string,
  hlsMasterKey: string,
  renditions: readonly HlsRendition[]
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.update(episodes).set({ hlsMasterKey, status: 'ready' }).where(eq(episodes.id, id));
    await setEpisodeHlsRenditions(tx, id, renditions);
  });
}

/** The hybrid-audio cache subdocument, flattened onto four columns. */
export async function setEpisodeCache(
  id: string,
  cache: { status: 'none' | 'cached' | 'hls'; objectKey?: string; cachedAt?: Date }
): Promise<void> {
  await getDb()
    .update(episodes)
    .set({
      cacheStatus: cache.status,
      cacheObjectKey: cache.objectKey ?? null,
      cacheCachedAt: cache.cachedAt ?? null,
    })
    .where(eq(episodes.id, id));
}

// ── Playback progress ─────────────────────────────────────────────────────

export interface EpisodeProgressRow {
  episodeId: string;
  positionSec: number;
  durationSec: number;
  completed: boolean;
}

export async function findEpisodeProgress(
  oxyUserId: string,
  episodeId: string
): Promise<{ positionSec: number; completed: boolean } | undefined> {
  const [row] = await getDb()
    .select({ positionSec: episodeProgress.positionSec, completed: episodeProgress.completed })
    .from(episodeProgress)
    .where(and(eq(episodeProgress.oxyUserId, oxyUserId), eq(episodeProgress.episodeId, episodeId)))
    .limit(1);
  return row;
}

/**
 * Save a listener's position. Idempotent on `(oxy_user_id, episode_id)`.
 *
 * `durationSec` is only written when supplied — the Mongo handler built its
 * `$set` the same way, because a client that reports a position without a
 * duration must not zero the duration it reported earlier.
 */
export async function upsertEpisodeProgress(
  oxyUserId: string,
  episodeId: string,
  values: { positionSec: number; durationSec?: number; completed: boolean }
): Promise<{ positionSec: number; completed: boolean }> {
  const set = {
    positionSec: values.positionSec,
    completed: values.completed,
    ...(values.durationSec === undefined ? {} : { durationSec: values.durationSec }),
    // See this module's doc comment: `$onUpdate` does not reach a conflict `set`,
    // and this column is the sort key of "continue listening".
    updatedAt: new Date(),
  };

  const [row] = await getDb()
    .insert(episodeProgress)
    .values({ oxyUserId, episodeId, ...set })
    .onConflictDoUpdate({
      target: [episodeProgress.oxyUserId, episodeProgress.episodeId],
      set,
    })
    .returning({ positionSec: episodeProgress.positionSec, completed: episodeProgress.completed });

  if (!row) throw new Error('upsertEpisodeProgress: upsert returned no row');
  return row;
}

/**
 * "Continue listening" — a user's unfinished episodes, most recently played
 * first.
 *
 * `episode_progress_oxy_user_id_updated_at_idx` is partial on `completed =
 * false`, which is this exact filter. `desc()` rather than `descNullsLast()` on
 * `updated_at` would be equivalent — the column is `NOT NULL` — but the spelling
 * stays uniform so nobody has to check which columns are nullable to know
 * whether an ordering is faithful.
 */
export async function listContinueListening(
  oxyUserId: string,
  limit: number
): Promise<EpisodeProgressRow[]> {
  return getDb()
    .select({
      episodeId: episodeProgress.episodeId,
      positionSec: episodeProgress.positionSec,
      durationSec: episodeProgress.durationSec,
      completed: episodeProgress.completed,
    })
    .from(episodeProgress)
    .where(and(eq(episodeProgress.oxyUserId, oxyUserId), eq(episodeProgress.completed, false)))
    .orderBy(descNullsLast(episodeProgress.updatedAt))
    .limit(limit);
}
