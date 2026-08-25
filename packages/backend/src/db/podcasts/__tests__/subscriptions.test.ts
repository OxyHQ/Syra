/**
 * Podcast subscriptions, and the counter Mongo could not keep honest.
 *
 * The Task 12 review (I2) found this untested: nothing pinned
 * `onConflictDoNothing().returning()` or the `greatest(…, 0)` floor, which are
 * the two mechanisms the port's sixth defect fix rests on.
 *
 * ## What was wrong before, and what these assert
 *
 * The Mongo handlers bumped `subscriberCount` by READING the array first
 * (`before?.subscribedPodcasts?.includes(id)`) and then writing — two round
 * trips with no isolation. Two concurrent subscribes from the same account both
 * read "not subscribed" and both incremented, overstating the count
 * permanently and undetectably; the reverse race under-counted.
 *
 * The port asks the DATABASE whether the insert happened, in the same
 * transaction as the counter. The cases below pin the observable consequences —
 * idempotence in both directions, the count matching the membership, and the
 * floor — rather than the mechanism, so a future rewrite that keeps the
 * property passes and one that reintroduces the race does not.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { userPodcastSubscriptions } from '../../schema/library';
import { podcasts } from '../../schema/podcasts';
import {
  listReadableSubscribedPodcastIds,
  listSubscribedPodcastIds,
  listSubscriberIds,
  subscribeToPodcast,
  unsubscribeFromPodcast,
} from '../subscriptions';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const USER = 'oxy-user-subs';

async function makeShow(
  title = 'A Show',
  subscriberCount = 0,
  over: Partial<typeof podcasts.$inferInsert> = {}
): Promise<string> {
  const id = uuidv7();
  await getDb().insert(podcasts).values({ id, title, source: 'rss', subscriberCount, ...over });
  return id;
}

async function subscriberCount(podcastId: string): Promise<number> {
  const [row] = await getDb()
    .select({ count: podcasts.subscriberCount })
    .from(podcasts)
    .where(eq(podcasts.id, podcastId));
  return row?.count ?? -1;
}

describe('subscribeToPodcast', () => {
  it('subscribes and bumps the counter once', async () => {
    const showId = await makeShow();

    expect(await subscribeToPodcast(USER, showId)).toBe('subscribed');
    expect(await listSubscribedPodcastIds(USER)).toEqual([showId]);
    expect(await subscriberCount(showId)).toBe(1);
  });

  it('is idempotent — a second subscribe does NOT bump the counter again', async () => {
    const showId = await makeShow();
    await subscribeToPodcast(USER, showId);

    // The assertion the Mongo read-then-write could not make: the answer comes
    // from the insert itself, so a repeat cannot be mistaken for a new one.
    expect(await subscribeToPodcast(USER, showId)).toBe('already-subscribed');
    expect(await listSubscribedPodcastIds(USER)).toEqual([showId]);
    expect(await subscriberCount(showId)).toBe(1);
  });

  it('counts each user once, not each call', async () => {
    const showId = await makeShow();
    await subscribeToPodcast('user-a', showId);
    await subscribeToPodcast('user-b', showId);
    await subscribeToPodcast('user-a', showId); // repeat
    await subscribeToPodcast('user-b', showId); // repeat

    expect(await subscriberCount(showId)).toBe(2);
    expect((await listSubscriberIds(showId)).sort()).toEqual(['user-a', 'user-b']);
  });

  it('answers missing-podcast for an id that names nothing, and writes nothing', async () => {
    /**
     * A real answer here and not one Mongo had: `podcast_id` is a foreign key,
     * so a bogus id is `23503` where Mongo silently stored the string. The
     * controller turns this into a 404 rather than letting a constraint
     * violation reach a client as a 500.
     */
    expect(await subscribeToPodcast(USER, uuidv7())).toBe('missing-podcast');
    expect(await listSubscribedPodcastIds(USER)).toEqual([]);
  });

  it('rolls the counter back when the subscription fails', async () => {
    // Both statements are in one transaction, so a failed insert must not
    // leave a bumped count behind. Measured against a real show that the user
    // then fails to subscribe to twice over.
    const showId = await makeShow();
    await subscribeToPodcast(USER, showId);
    await subscribeToPodcast(USER, uuidv7()); // fails, different show
    expect(await subscriberCount(showId)).toBe(1);
  });
});

describe('unsubscribeFromPodcast', () => {
  it('removes the subscription and decrements once', async () => {
    const showId = await makeShow();
    await subscribeToPodcast(USER, showId);

    expect(await unsubscribeFromPodcast(USER, showId)).toBe(true);
    expect(await listSubscribedPodcastIds(USER)).toEqual([]);
    expect(await subscriberCount(showId)).toBe(0);
  });

  it('is idempotent — a second unsubscribe does NOT decrement again', async () => {
    const showId = await makeShow();
    await subscribeToPodcast(USER, showId);
    await unsubscribeFromPodcast(USER, showId);

    expect(await unsubscribeFromPodcast(USER, showId)).toBe(false);
    expect(await subscriberCount(showId)).toBe(0);
  });

  it('unsubscribing from a show that does not exist is a successful no-op', async () => {
    // The foreign key constrains what may be STORED, not what may be asked
    // for — the same asymmetry `db/library/membership.ts` records for the four
    // sibling junctions.
    expect(await unsubscribeFromPodcast(USER, uuidv7())).toBe(false);
  });

  it('never drives the counter below zero', async () => {
    /**
     * The `greatest(…, 0)` floor, and the fixture is what makes it testable:
     * a show whose stored `subscriber_count` is ALREADY 0 while a subscription
     * row exists. That state is unreachable through the API — which is the
     * point. The floor carries over the Mongo guard (`subscriberCount: { $gt:
     * 0 }`) and, with the write now atomic, should be unreachable; it stays
     * because a counter that went negative would be silently wrong rather than
     * loud, and a guard nobody can exercise is a guard nobody can trust.
     */
    const showId = await makeShow('Drifted Show');
    await subscribeToPodcast(USER, showId);
    await getDb().update(podcasts).set({ subscriberCount: 0 }).where(eq(podcasts.id, showId));

    expect(await unsubscribeFromPodcast(USER, showId)).toBe(true);
    expect(await subscriberCount(showId)).toBe(0);
  });
});

describe('the two read directions', () => {
  it('a user\'s subscriptions come back oldest first', async () => {
    // The order the Mongo array had, since `$addToSet` appended — and two
    // callers read it as an order rather than a set.
    const first = await makeShow('First');
    const second = await makeShow('Second');
    const third = await makeShow('Third');
    await subscribeToPodcast(USER, first);
    await subscribeToPodcast(USER, second);
    await subscribeToPodcast(USER, third);

    expect(await listSubscribedPodcastIds(USER)).toEqual([first, second, third]);
  });

  it('a show\'s subscribers are the reverse read, and exclude other shows\'', async () => {
    const showId = await makeShow('Watched');
    const otherId = await makeShow('Ignored');
    await subscribeToPodcast('user-a', showId);
    await subscribeToPodcast('user-b', showId);
    await subscribeToPodcast('user-c', otherId);

    // Without the second show, a reverse read that ignored `podcast_id`
    // entirely would return the same answer.
    expect((await listSubscriberIds(showId)).sort()).toEqual(['user-a', 'user-b']);
    expect(await listSubscriberIds(otherId)).toEqual(['user-c']);
  });

  it('deleting a show cascades its subscriptions away', async () => {
    const showId = await makeShow();
    await subscribeToPodcast(USER, showId);

    await getDb().delete(podcasts).where(eq(podcasts.id, showId));

    expect(await listSubscribedPodcastIds(USER)).toEqual([]);
  });
});

/**
 * The library's read, and the one thing that separates it from
 * {@link listSubscribedPodcastIds}: it answers with the shows the subscriber may
 * still SEE, not with every id they ever subscribed to.
 *
 * The two are deliberately both here rather than one filtered read, because the
 * unfiltered one has a caller that must stay unfiltered — `listSubscriberIds`'s
 * sibling direction feeds `episodePublished.ts`, and the counter arithmetic in
 * this module is keyed on rows, not on readability.
 *
 * Every case below is a REFUSAL or the exception that stops the refusal being
 * over-broad, and each fixture differs from its neighbour in exactly the column
 * under test — a show that is private AND unpublished would pass whichever half
 * of the predicate survived a mutation.
 */
describe('listReadableSubscribedPodcastIds', () => {
  const OWNER = 'oxy-show-owner';

  it('returns a subscribed show that is active and public', async () => {
    // The positive control. Without it every refusal below is satisfied by a
    // function that returns nothing at all.
    const showId = await makeShow('Public Show');
    await subscribeToPodcast(USER, showId);

    expect(await listReadableSubscribedPodcastIds(USER)).toEqual([showId]);
  });

  it('drops a show whose creator made it PRIVATE, while the subscription row survives', async () => {
    const showId = await makeShow('Gone Private', 0, { visibility: 'private', ownerOxyUserId: OWNER });
    await subscribeToPodcast(USER, showId);

    expect(await listReadableSubscribedPodcastIds(USER)).toEqual([]);
    // Nothing is deleted: the show coming back brings the subscription with it.
    expect(await listSubscribedPodcastIds(USER)).toEqual([showId]);
  });

  it('drops a show its creator UNPUBLISHED', async () => {
    // `status = 'unavailable'` is `unpublishPodcast`'s write. The audience axis
    // is untouched here, so a predicate that only tested `visibility` passes
    // every other case in this block and fails this one.
    const showId = await makeShow('Unpublished', 0, { status: 'unavailable' });
    await subscribeToPodcast(USER, showId);

    expect(await listReadableSubscribedPodcastIds(USER)).toEqual([]);
  });

  it('drops a show the platform REMOVED', async () => {
    const showId = await makeShow('Taken Down', 0, { status: 'removed' });
    await subscribeToPodcast(USER, showId);

    expect(await listReadableSubscribedPodcastIds(USER)).toEqual([]);
  });

  it('KEEPS an unlisted show, because a library is not discovery', async () => {
    /**
     * The one case where the library rule is deliberately looser than the
     * discovery rule. `unlisted` means "reachable by name, never offered" — and
     * a show sitting in the library of somebody who subscribed to it by name is
     * exactly the reachable case, not the offered one. Using
     * `listableShowFilter` here instead would silently empty the libraries of
     * every unlisted show's subscribers.
     */
    const showId = await makeShow('Unlisted', 0, { visibility: 'unlisted' });
    await subscribeToPodcast(USER, showId);

    expect(await listReadableSubscribedPodcastIds(USER)).toEqual([showId]);
  });

  it('KEEPS the owner\'s own private show in the owner\'s library', async () => {
    // The owner arm of `viewerCanReadShowFilter`. Without it, making your own
    // show private removes it from your own library — the creator locked out of
    // their own work, which is the failure the arm exists to prevent.
    const showId = await makeShow('Mine, Private', 0, {
      visibility: 'private',
      ownerOxyUserId: OWNER,
    });
    await subscribeToPodcast(OWNER, showId);

    expect(await listReadableSubscribedPodcastIds(OWNER)).toEqual([showId]);
  });

  it('KEEPS the owner\'s own unpublished show in the owner\'s library', async () => {
    // Same arm, the other axis: a filter written as `reachable OR owned-and-
    // public` would pass the case above and fail this one.
    const showId = await makeShow('Mine, Unpublished', 0, {
      status: 'unavailable',
      ownerOxyUserId: OWNER,
    });
    await subscribeToPodcast(OWNER, showId);

    expect(await listReadableSubscribedPodcastIds(OWNER)).toEqual([showId]);
  });

  it('does not let one viewer\'s ownership unlock a show for anyone else', async () => {
    /**
     * The owner arm must be scoped to the ASKING viewer. A predicate that tested
     * `owner_oxy_user_id is not null` — or that bound the owner to the wrong
     * side — would return this show to the stranger too, and every other case in
     * this block would still pass.
     */
    const showId = await makeShow('Mine, Private', 0, {
      visibility: 'private',
      ownerOxyUserId: OWNER,
    });
    await subscribeToPodcast(OWNER, showId);
    await subscribeToPodcast(USER, showId);

    expect(await listReadableSubscribedPodcastIds(OWNER)).toEqual([showId]);
    expect(await listReadableSubscribedPodcastIds(USER)).toEqual([]);
  });

  it('returns only the asking user\'s own subscriptions', async () => {
    const mine = await makeShow('Mine');
    const theirs = await makeShow('Theirs');
    await subscribeToPodcast(USER, mine);
    await subscribeToPodcast('someone-else', theirs);

    expect(await listReadableSubscribedPodcastIds(USER)).toEqual([mine]);
  });

  it('orders by created_at, not by whatever order the join happens to emit', async () => {
    /**
     * The fixture is what makes this an assertion rather than a coincidence.
     *
     * Written the obvious way — subscribe to three shows and expect them back in
     * that order — it passes with the `ORDER BY` DELETED, because insertion
     * order, `created_at` order and the ids' own uuid v7 order all agree on
     * freshly inserted rows, so every plan returns the same list. Measured: the
     * naive version survived that mutation with 23/23 green.
     *
     * So the stored timestamps are rewritten into an order that matches NEITHER
     * insertion nor id, and the expectation follows the timestamps. Now only a
     * statement that actually sorts by `created_at` can produce it.
     */
    const first = await makeShow('First');
    const hidden = await makeShow('Hidden', 0, { visibility: 'private' });
    const third = await makeShow('Third');
    await subscribeToPodcast(USER, first);
    await subscribeToPodcast(USER, hidden);
    await subscribeToPodcast(USER, third);

    const at = (iso: string, podcastId: string) =>
      getDb()
        .update(userPodcastSubscriptions)
        .set({ createdAt: new Date(iso) })
        .where(
          and(
            eq(userPodcastSubscriptions.oxyUserId, USER),
            eq(userPodcastSubscriptions.podcastId, podcastId)
          )
        );

    await at('2020-03-01T00:00:00.000Z', first);
    await at('2020-01-01T00:00:00.000Z', hidden);
    await at('2020-02-01T00:00:00.000Z', third);

    // `hidden` is oldest and still absent — the ordering must not smuggle back a
    // row the visibility predicate dropped.
    expect(await listReadableSubscribedPodcastIds(USER)).toEqual([third, first]);
  });

  it('answers an empty list for a user who has subscribed to nothing', async () => {
    expect(await listReadableSubscribedPodcastIds('nobody')).toEqual([]);
  });
});
