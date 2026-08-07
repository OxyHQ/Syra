/**
 * The per-user play log, on drizzle — the port of `models/RecentlyPlayed.ts`.
 *
 * One row per play event, deduped on read and capped on write, exactly as the
 * Mongo version was. Three operations, each a direct translation of one
 * Mongo pipeline or query, and each with something worth naming:
 *
 *  - {@link findRecentTrackIds} was a five-stage aggregation. `group by
 *    track_id` with `max(played_at)` is the same collapse, and the index
 *    `(oxy_user_id, played_at desc)` serves it — see
 *    `__tests__/library.explain.test.ts`.
 *  - {@link touchRecentPlay} was `findOneAndUpdate`, which updates exactly ONE
 *    document. A bare `UPDATE … WHERE played_at >= …` updates every matching
 *    row, so the statement here narrows to a single id first. Within the
 *    30-second window there should never be two rows for one track — that is
 *    what this function exists to ensure — but "should never" is the kind of
 *    invariant a concurrent pair of requests breaks, and the port should not
 *    quietly widen a single-row update into an unbounded one.
 *  - {@link prunePlayHistory} keeps Mongo's `skip(N).limit(1)` cutoff shape,
 *    including its `<=`, which deletes ties along with the cutoff row.
 */

import { and, desc, eq, gte, inArray, lte, max } from 'drizzle-orm';
import { getDb } from '../postgres';
import { recentlyPlayed } from '../schema/library';

/**
 * The user's most recent DISTINCT tracks, newest play first.
 *
 * Returns ids, not tracks: the catalog lookup is a separate query so a play of
 * a track that has since been taken down simply resolves to nothing, the same
 * way the Mongo version's `$in` did.
 */
export async function findRecentTrackIds(
  oxyUserId: string,
  limit: number
): Promise<string[]> {
  const rows = await getDb()
    .select({ trackId: recentlyPlayed.trackId })
    .from(recentlyPlayed)
    .where(eq(recentlyPlayed.oxyUserId, oxyUserId))
    .groupBy(recentlyPlayed.trackId)
    .orderBy(desc(max(recentlyPlayed.playedAt)))
    .limit(limit);

  return rows.map((row) => row.trackId);
}

/**
 * Refresh the timestamp of a recent play of this track, if there is one.
 *
 * `true` when a row was refreshed and no insert is needed — the answer
 * `findOneAndUpdate` gave by returning a document.
 */
export async function touchRecentPlay(
  oxyUserId: string,
  trackId: string,
  since: Date,
  now: Date
): Promise<boolean> {
  // The single most recent qualifying row, so this stays the one-document
  // update `findOneAndUpdate` was. See the file's doc comment.
  const mostRecent = getDb()
    .select({ id: recentlyPlayed.id })
    .from(recentlyPlayed)
    .where(
      and(
        eq(recentlyPlayed.oxyUserId, oxyUserId),
        eq(recentlyPlayed.trackId, trackId),
        gte(recentlyPlayed.playedAt, since)
      )
    )
    .orderBy(desc(recentlyPlayed.playedAt))
    .limit(1);

  const refreshed = await getDb()
    .update(recentlyPlayed)
    .set({ playedAt: now })
    .where(inArray(recentlyPlayed.id, mostRecent))
    .returning({ id: recentlyPlayed.id });

  return refreshed.length > 0;
}

/** Log a play. */
export async function recordPlayEvent(
  oxyUserId: string,
  trackId: string,
  playedAt: Date
): Promise<void> {
  await getDb().insert(recentlyPlayed).values({ oxyUserId, trackId, playedAt });
}

/**
 * Drop everything past the retention window for one user.
 *
 * The cutoff is the `retention`-th newest row's timestamp and the delete is
 * `<=` it, so rows sharing that instant go too — Mongo's behaviour, kept
 * because a batch of plays written in the same millisecond should not be half
 * retained. When the user has fewer rows than the window the subquery answers
 * nothing and the `where` matches nothing.
 */
export async function prunePlayHistory(oxyUserId: string, retention: number): Promise<void> {
  const [cutoff] = await getDb()
    .select({ playedAt: recentlyPlayed.playedAt })
    .from(recentlyPlayed)
    .where(eq(recentlyPlayed.oxyUserId, oxyUserId))
    .orderBy(desc(recentlyPlayed.playedAt))
    .offset(retention)
    .limit(1);

  if (!cutoff) return;

  await getDb()
    .delete(recentlyPlayed)
    .where(
      and(eq(recentlyPlayed.oxyUserId, oxyUserId), lte(recentlyPlayed.playedAt, cutoff.playedAt))
    );
}
