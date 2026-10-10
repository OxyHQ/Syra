/**
 * The per-user play log, on drizzle.
 *
 * One row per play event, deduped on read and capped on write. Three
 * operations, each with something worth naming:
 *
 *  - {@link findRecentTrackIds} collapses with `group by track_id` and
 *    `max(played_at)`, and the index
 *    `(oxy_user_id, played_at desc)` serves it — see
 *    `__tests__/library.explain.test.ts`.
 *  - {@link touchRecentPlay} updates exactly ONE row. A bare `UPDATE … WHERE played_at >= …` updates every matching
 *    row, so the statement here narrows to a single id first. Within the
 *    30-second window there should never be two rows for one track — that is
 *    what this function exists to ensure — but "should never" is the kind of
 *    invariant a concurrent pair of requests breaks, and a single-row update
 *    must not quietly widen into an unbounded one.
 *  - {@link prunePlayHistory} cuts off at the N-th newest row with `<=`, which
 *    deletes ties along with the cutoff row.
 */

import { and, desc, eq, gte, inArray, lte, max } from 'drizzle-orm';
import { descNullsLast } from '../catalog/containers';
import { getDb } from '../postgres';
import { recentlyPlayed } from '../schema/library';

/**
 * The user's most recent DISTINCT tracks, newest play first.
 *
 * Returns ids, not tracks: the catalog lookup is a separate query so a play of
 * a track that has since been taken down simply resolves to nothing.
 */
export async function findRecentTrackIds(oxyUserId: string, limit: number): Promise<string[]> {
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
  now: Date,
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
        gte(recentlyPlayed.playedAt, since),
      ),
    )
    .orderBy(descNullsLast(recentlyPlayed.playedAt))
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
  playedAt: Date,
): Promise<void> {
  await getDb().insert(recentlyPlayed).values({ oxyUserId, trackId, playedAt });
}

/**
 * Drop everything past the retention window for one user.
 *
 * The cutoff is the `retention`-th newest row's timestamp and the delete is
 * `<=` it, so rows sharing that instant go too, because a batch of plays written in the same millisecond should not be half
 * retained. When the user has fewer rows than the window the subquery answers
 * nothing and the `where` matches nothing.
 */
export async function prunePlayHistory(oxyUserId: string, retention: number): Promise<void> {
  const [cutoff] = await getDb()
    .select({ playedAt: recentlyPlayed.playedAt })
    .from(recentlyPlayed)
    .where(eq(recentlyPlayed.oxyUserId, oxyUserId))
    .orderBy(descNullsLast(recentlyPlayed.playedAt))
    .offset(retention)
    .limit(1);

  if (!cutoff) return;

  await getDb()
    .delete(recentlyPlayed)
    .where(
      and(eq(recentlyPlayed.oxyUserId, oxyUserId), lte(recentlyPlayed.playedAt, cutoff.playedAt)),
    );
}
