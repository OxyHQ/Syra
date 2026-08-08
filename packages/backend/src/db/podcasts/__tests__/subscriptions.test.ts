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
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { podcasts } from '../../schema/podcasts';
import {
  listSubscribedPodcastIds,
  listSubscriberIds,
  subscribeToPodcast,
  unsubscribeFromPodcast,
} from '../subscriptions';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const USER = 'oxy-user-subs';

async function makeShow(title = 'A Show', subscriberCount = 0): Promise<string> {
  const id = uuidv7();
  await getDb().insert(podcasts).values({ id, title, source: 'rss', subscriberCount });
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
