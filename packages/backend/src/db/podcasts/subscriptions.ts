/**
 * Podcast subscriptions — the fifth `UserLibrary` array, and the last one to
 * move.
 *
 * Task 11 ported the other four (`db/library/membership.ts`) and could not port
 * this one: `user_podcast_subscriptions.podcast_id` is a real foreign key to
 * `podcasts`, and nothing wrote that table until this task, so every insert
 * would have hit `23503` against an empty table. That is why `models/Library.ts`
 * survived Task 11 narrowed to one field. With `controllers/podcasts.controller`
 * on drizzle the constraint is satisfiable, the model is deleted, and this
 * module is what replaced it.
 *
 * ## The counter race Mongo had, and that this does not
 *
 * `subscribePodcast` had to bump `subscriberCount` exactly once per user, and it
 * did it by READING the array first (`before?.subscribedPodcasts?.includes(id)`)
 * and then writing — two round trips with no isolation between them. Two
 * concurrent subscribes from the same account both read "not subscribed" and
 * both incremented, permanently overstating the count with no way to detect it
 * after the fact; the reverse race under-counts on unsubscribe.
 *
 * `insert … onConflictDoNothing().returning()` answers "did this insert actually
 * happen" from the database, atomically, and `delete … returning()` does the
 * same for removal. The counter update then rides in the SAME transaction, so
 * the count and the membership cannot disagree even under concurrency. This is a
 * behaviour IMPROVEMENT rather than parity, and it is called out because a
 * reviewer comparing against Mongo will find the read-then-write gone and should
 * know it was deliberate.
 *
 * ## `subscriberCount` is not derived, and that is a deliberate keep
 *
 * It could be `count(*)` over this table. It is not, because `podcasts_rss_
 * active_subscriber_count_idx` orders the refresh scheduler's batch by it and
 * `podcasts_active_popularity_idx` uses it as a sort key — both would become
 * aggregate scans. The stored counter stays, and the transaction is what keeps
 * it honest.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { isForeignKeyViolation } from '@oxyhq/db';
import { getDb } from '../postgres';
import { userPodcastSubscriptions } from '../schema/library';
import { podcasts } from '../schema/podcasts';
import { viewerCanReadShowFilter } from './visibility';

/** The foreign key that fires when the podcast id names nothing. */
const MISSING_PODCAST_CONSTRAINT = 'user_podcast_subscriptions_podcast_id_podcasts_id_fk';

/**
 * One user's subscribed show ids, oldest first.
 *
 * The order is `created_at`, matching the four sibling memberships and the Mongo
 * array it replaces — `$addToSet` appended, so the document recorded when each
 * subscription was added simply by where it sat.
 */
export async function listSubscribedPodcastIds(oxyUserId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ podcastId: userPodcastSubscriptions.podcastId })
    .from(userPodcastSubscriptions)
    .where(eq(userPodcastSubscriptions.oxyUserId, oxyUserId))
    .orderBy(asc(userPodcastSubscriptions.createdAt));

  return rows.map((row) => row.podcastId);
}

/**
 * The subset of {@link listSubscribedPodcastIds} the subscriber may still SEE —
 * the library's read.
 *
 * ## Why this is a separate function and not a filter on the other one
 *
 * The unfiltered read has callers that must stay unfiltered: the counter
 * arithmetic above is keyed on ROWS, and `episodePublished.ts` fans out over
 * every subscriber of a show regardless of what any one of them may read. So
 * "which ids exist" and "which ids resolve to something this viewer can open"
 * are two questions, and the second one is the library's.
 *
 * ## Why the FLAT predicate, and why that is not an accident
 *
 * `podcasts` is in this statement's FROM list (joined), so
 * {@link viewerCanReadShowFilter} — the plain column comparison — resolves
 * against the joined table and means what it says. The correlated spelling
 * (`showIsReadableByViewer`) would be wrong here for the reason `visibility.ts`
 * states at length: its inner `podcasts` reference would shadow the joined one
 * and be TRUE for every row as soon as any readable show existed anywhere, which
 * a fixture with one show cannot see.
 *
 * ## What a subscriber sees when a show goes private
 *
 * Nothing. The show leaves this list — and therefore the library — while the
 * subscription ROW survives untouched, so the show reappears with the
 * subscription intact if its creator publishes it again. That is the same answer
 * `findPodcastsByIds` already gives `GET /api/podcasts/subscriptions`, and the
 * two agreeing is the point: a membership snapshot that claimed a subscription
 * the hydrated list then dropped would render a library counting shows it cannot
 * show. Unsubscribing still works on a show in that state
 * (`unsubscribeFromPodcast` gates on nothing), so the row is never stranded
 * beyond reach.
 *
 * `unlisted` is deliberately KEPT. The rule is REACHABLE, not LISTABLE: a
 * library holds what its owner asked for by name, which is exactly what
 * `unlisted` permits, and applying the discovery rule here would empty the
 * library of every unlisted show's subscribers for no gain.
 */
export async function listReadableSubscribedPodcastIds(oxyUserId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ podcastId: userPodcastSubscriptions.podcastId })
    .from(userPodcastSubscriptions)
    .innerJoin(podcasts, eq(podcasts.id, userPodcastSubscriptions.podcastId))
    .where(
      and(
        eq(userPodcastSubscriptions.oxyUserId, oxyUserId),
        viewerCanReadShowFilter(oxyUserId)
      )
    )
    .orderBy(asc(userPodcastSubscriptions.createdAt));

  return rows.map((row) => row.podcastId);
}

/**
 * Every subscriber of one show — the reverse fan-out
 * `services/notifications/triggers/episodePublished.ts` runs on a new episode.
 *
 * `user_podcast_subscriptions_podcast_id_idx` exists for exactly this read: it
 * is the one direction the `unique(oxy_user_id, podcast_id)` constraint cannot
 * serve, since that index leads with the user.
 */
export async function listSubscriberIds(podcastId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ oxyUserId: userPodcastSubscriptions.oxyUserId })
    .from(userPodcastSubscriptions)
    .where(eq(userPodcastSubscriptions.podcastId, podcastId));

  return rows.map((row) => row.oxyUserId);
}

/** What {@link subscribeToPodcast} can answer. */
export type SubscribeResult = 'subscribed' | 'already-subscribed' | 'missing-podcast';

/**
 * Subscribe, idempotently, bumping `subscriberCount` exactly once.
 *
 * `'missing-podcast'` when the id names nothing — a real answer here and not one
 * Mongo had, for the same reason `addMembership` gained it: the column is a
 * foreign key, so a bogus id is `23503` where Mongo silently stored the string.
 * The controller turns it into a 404 rather than letting it reach a client as a
 * 500.
 */
export async function subscribeToPodcast(
  oxyUserId: string,
  podcastId: string
): Promise<SubscribeResult> {
  try {
    return await getDb().transaction(async (tx) => {
      const inserted = await tx
        .insert(userPodcastSubscriptions)
        .values({ oxyUserId, podcastId })
        .onConflictDoNothing()
        .returning({ id: userPodcastSubscriptions.id });

      if (inserted.length === 0) return 'already-subscribed';

      await tx
        .update(podcasts)
        .set({ subscriberCount: sql`${podcasts.subscriberCount} + 1` })
        .where(eq(podcasts.id, podcastId));

      return 'subscribed';
    });
  } catch (error) {
    if (isForeignKeyViolation(error, MISSING_PODCAST_CONSTRAINT)) return 'missing-podcast';
    throw error;
  }
}

/**
 * Unsubscribe, idempotently. Returns whether a subscription was actually
 * removed, which is what decides whether the counter moves.
 *
 * Unsubscribing from a show that does not exist is a successful no-op, exactly
 * as the Mongo `$pull` was: the foreign key constrains what may be STORED, not
 * what may be asked for. The counter's `greatest(…, 0)` floor carries over the
 * Mongo guard (`{ subscriberCount: { $gt: 0 } }`) — with the write now atomic it
 * should be unreachable, and it stays because a counter that went negative would
 * be silently wrong rather than loud.
 */
export async function unsubscribeFromPodcast(
  oxyUserId: string,
  podcastId: string
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const removed = await tx
      .delete(userPodcastSubscriptions)
      .where(
        and(
          eq(userPodcastSubscriptions.oxyUserId, oxyUserId),
          eq(userPodcastSubscriptions.podcastId, podcastId)
        )
      )
      .returning({ id: userPodcastSubscriptions.id });

    if (removed.length === 0) return false;

    await tx
      .update(podcasts)
      .set({ subscriberCount: sql`greatest(${podcasts.subscriberCount} - 1, 0)` })
      .where(eq(podcasts.id, podcastId));

    return true;
  });
}
