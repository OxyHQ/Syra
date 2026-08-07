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

import { and, count, eq, getTableColumns, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { EpisodePerson, EpisodeTranscript, HlsRendition } from '@syra/shared-types';
import { getDb, type DbOrTransaction } from '../postgres';
import { episodeProgress, episodes } from '../schema/podcasts';
import { descNullsLast } from '../catalog/containers';
import { textSearch } from '../catalog/search';
import { setEpisodeHlsRenditions, setEpisodePersons, setEpisodeTranscripts } from './children';
import { episodeCreditsPerson, type CreditIdentity } from './persons';
import { publiclyPlayableEpisodeFilter } from './visibility';
import type { EpisodeRow } from './serialize';

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

export async function findEpisodeById(id: string): Promise<EpisodeRow | undefined> {
  const [row] = await getDb().select().from(episodes).where(eq(episodes.id, id)).limit(1);
  return row;
}

export async function findEpisodesByIds(ids: readonly string[]): Promise<EpisodeRow[]> {
  if (ids.length === 0) return [];
  return getDb()
    .select()
    .from(episodes)
    .where(and(inArray(episodes.id, [...ids]), ne(episodes.status, 'unavailable')));
}

/**
 * One show's episodes, newest first.
 *
 * `visibility` is `episodeVisibilityFilter`'s output — `undefined` for the
 * show's owner, who sees every status. Served by
 * `episodes_podcast_id_pub_date_idx`, which `schema/podcasts.ts` deliberately
 * keeps NON-partial for exactly this: a `status = 'ready'` partial index would
 * silently stop serving the owner's own unpublished-episode view.
 */
export async function findEpisodesByShow(
  podcastId: string,
  options: { visibility: SQL | undefined; offset?: number; limit: number }
): Promise<EpisodeRow[]> {
  return getDb()
    .select()
    .from(episodes)
    .where(and(eq(episodes.podcastId, podcastId), options.visibility))
    .orderBy(descNullsLast(episodes.pubDate))
    .offset(options.offset ?? 0)
    .limit(options.limit);
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

/** Every episode of a show, for the generated public RSS feed. */
export async function findFeedEpisodes(podcastId: string, limit: number): Promise<EpisodeRow[]> {
  return getDb()
    .select()
    .from(episodes)
    .where(and(eq(episodes.podcastId, podcastId), ne(episodes.status, 'unavailable')))
    .orderBy(descNullsLast(episodes.pubDate))
    .limit(limit);
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

export async function insertEpisode(
  values: typeof episodes.$inferInsert,
  children: EpisodeChildValues = {}
): Promise<EpisodeRow> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx.insert(episodes).values(values).returning();
    if (!row) throw new Error('insertEpisode: insert returned no row');
    await writeChildren(tx, row.id, children);
    return row;
  });
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
