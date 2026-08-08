/**
 * `listening_events` — the canonical engagement log, on drizzle.
 *
 * One immutable row per finished or abandoned play. Two things read it: the
 * co-occurrence miner walks every user's events in time order, and the
 * personalised shelf reads one listener's most recent plays as an exclusion set.
 *
 * ## This is the table the expiry sweep exists for
 *
 * It is the only high-arrival-rate table in this vertical, and Mongo bounded it
 * with a 90-day TTL index. `db/expiry.ts` carries the replacement entry; nothing
 * here reaps, and nothing here should. **Neither reader may start filtering on
 * `played_at` as a substitute** — {@link findRecentTrackIds} deliberately does
 * not filter by time, and `schema/user.ts` records at length why that is safe
 * (the rows become a recently-played exclusion set, so a stale one costs one
 * track staying out of recommendations for at most one sweep interval) rather
 * than claiming a filter that was never there.
 *
 * ## Why the miner is keyset-paginated rather than one big read
 *
 * The Mongo miner used a server-side cursor, so its 500,000-event cap never
 * materialised in one buffer. Selecting the same cap in one drizzle statement
 * would — so {@link forEachMinableEvent} pages through
 * `(oxy_user_id, played_at, id)`, which is a TOTAL order and therefore cannot
 * skip or repeat a row across pages the way an `offset` can under concurrent
 * inserts. `listening_events_oxy_user_id_played_at_idx` serves both the ordering
 * and the seek.
 *
 * The order is the algorithm, not a preference: the miner splits a user's events
 * into sessions by the gap between consecutive `played_at` values, so a page
 * boundary that reordered rows would invent or destroy sessions.
 */

import { and, asc, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import { getDb, type DbOrTransaction } from '../postgres';
import { LISTENING_SOURCES, listeningEvents } from '../schema/user';

export type ListeningSource = (typeof LISTENING_SOURCES)[number];

/** The columns the co-occurrence miner reads — nothing else is loaded. */
export interface MinableEvent {
  oxyUserId: string;
  trackId: string;
  artistId: string;
  playedAt: Date;
}

/**
 * Rows fetched per page while walking the log.
 *
 * Overridable per call rather than a fixed constant, because a suite that cannot
 * set it cannot reach the SEEK at all: with one page larger than the fixture,
 * `forEachMinableEvent` returns everything on the first query and the keyset —
 * the whole reason this function is not one big read — is never executed. The
 * paging test sets it to a handful of rows for exactly that reason.
 */
const DEFAULT_MINE_PAGE_SIZE = 10_000;

/** A new play. Every field the caller does not supply takes its column default. */
export interface NewListeningEvent {
  oxyUserId: string;
  trackId: string;
  artistId: string;
  genre?: string;
  durationSec?: number;
  listenedSec: number;
  completion: number;
  skipped: boolean;
  source: ListeningSource;
  playedAt: Date;
}

/**
 * Record one play.
 *
 * `track_id` and `artist_id` are real foreign keys, so an event for a track that
 * does not exist is a `23503` rather than a silently stored string. `recordPlay`
 * reads the track first and derives both ids from it, so the row it writes is
 * guaranteed to reference rows that existed a moment earlier.
 */
export async function insertListeningEvent(
  event: NewListeningEvent,
  db: DbOrTransaction = getDb(),
): Promise<void> {
  await db.insert(listeningEvents).values(event);
}

/**
 * One listener's most recently played track ids, newest first.
 *
 * `desc(playedAt)` rather than a raw `desc` string: `played_at` is `notNull()`,
 * so the `NULLS FIRST` inversion Postgres applies to a descending sort has no
 * null branch to put first, and the order matches Mongo's `{ playedAt: -1 }`.
 *
 * Duplicates are NOT collapsed here. The caller folds the result into a `Set`
 * with its liked tracks, so de-duplicating in SQL would cost a `distinct` for a
 * result the caller discards — and `limit` means the most recent N EVENTS, which
 * is what the Mongo read returned.
 */
export async function findRecentTrackIds(
  oxyUserId: string,
  limit: number,
  db: DbOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ trackId: listeningEvents.trackId })
    .from(listeningEvents)
    .where(eq(listeningEvents.oxyUserId, oxyUserId))
    .orderBy(desc(listeningEvents.playedAt))
    .limit(limit);

  return rows.map((row) => row.trackId);
}

/**
 * Walk every minable event since `since`, in `(oxyUserId, playedAt)` order,
 * stopping after `maxEvents`.
 *
 * A callback rather than an array or an async generator: the miner folds each
 * event into two in-memory graphs and never needs the events themselves again,
 * so nothing is served by materialising them, and a callback keeps the paging
 * (and its total-order seek) entirely inside this module.
 *
 * Returns how many events were visited.
 */
export async function forEachMinableEvent(
  filter: { since: Date; minCompletion: number; maxEvents: number; pageSize?: number },
  visit: (event: MinableEvent) => void,
  db: DbOrTransaction = getDb(),
): Promise<number> {
  let seek: (MinableEvent & { id: string }) | undefined;
  let visited = 0;

  while (visited < filter.maxEvents) {
    const pageSize = Math.min(
      filter.pageSize ?? DEFAULT_MINE_PAGE_SIZE,
      filter.maxEvents - visited
    );

    const page = await db
      .select({
        oxyUserId: listeningEvents.oxyUserId,
        trackId: listeningEvents.trackId,
        artistId: listeningEvents.artistId,
        playedAt: listeningEvents.playedAt,
        id: listeningEvents.id,
      })
      .from(listeningEvents)
      .where(and(minableFilter(filter.since, filter.minCompletion), afterSeek(seek)))
      .orderBy(asc(listeningEvents.oxyUserId), asc(listeningEvents.playedAt), asc(listeningEvents.id))
      .limit(pageSize);

    if (page.length === 0) break;

    for (const row of page) {
      visit(row);
      visited += 1;
    }

    // The seek key carries `id`, so the next page resumes strictly after the
    // last row even when several events share one `played_at`.
    const last = page[page.length - 1];
    seek = last;
    if (page.length < pageSize) break;
  }

  return visited;
}

function minableFilter(since: Date, minCompletion: number): SQL {
  const condition = and(
    gte(listeningEvents.playedAt, since),
    gte(listeningEvents.completion, minCompletion),
    eq(listeningEvents.skipped, false),
  );
  if (!condition) throw new Error('minable filter composed to nothing');
  return condition;
}

/**
 * The row-comparison seek. `(a, b, c) > (x, y, z)` is a single comparison
 * Postgres can drive from the leading columns of
 * `listening_events_oxy_user_id_played_at_idx`, unlike the `a > x OR (a = x AND
 * …)` expansion, which it cannot.
 *
 * ## `playedAt` is rendered and CAST, not interpolated as a `Date`
 *
 * A value interpolated into a raw `` sql`…` `` template reaches the driver
 * UNMAPPED — drizzle only applies a column's codec when it knows which column a
 * value belongs to, and in a hand-written row comparison it does not. Passing
 * the `Date` straight through threw `ERR_INVALID_ARG_TYPE` out of postgres.js
 * (`Buffer.byteLength` on a `Date`), not a SQL error, so the failure surfaced
 * nowhere near the type that caused it.
 *
 * It was also INVISIBLE until the walk actually paged: `afterSeek` returns
 * `undefined` for the first page, so any pass under one page size never built
 * this predicate at all. In production that meant a co-occurrence pass would
 * have run fine until the log first exceeded 10,000 minable events and then
 * thrown on every subsequent run.
 *
 * The explicit `::timestamptz` states the type rather than leaving it to
 * Postgres's inference from the comparison's left side — the two text columns
 * need no such help, since a string maps to `text` correctly on its own.
 */
function afterSeek(seek: (MinableEvent & { id: string }) | undefined): SQL | undefined {
  if (!seek) return undefined;
  return sql`(${listeningEvents.oxyUserId}, ${listeningEvents.playedAt}, ${listeningEvents.id})
    > (${seek.oxyUserId}, ${seek.playedAt.toISOString()}::timestamptz, ${seek.id})`;
}
