import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../../db/postgres';
import { userPodcastSubscriptions } from '../../../db/schema/library';
import { podcasts } from '../../../db/schema/podcasts';
import { EPISODE_NOTIFY_MAX_AGE_MS, notifySubscribersOfNewEpisode } from './episodePublished';

/** Injected so the trigger tests exercise fan-out, not the credential-absent path. */
const testDeps = { getToken: async () => 'test-service-token' };

/**
 * The age gate is the half of the anti-spam design that coalescing cannot provide:
 * importing an archive must notify NOBODY, however many subscribers the show has.
 */

/**
 * Real `podcasts` rows, not bare strings.
 *
 * `user_podcast_subscriptions.podcast_id` is a real foreign key — the one that
 * kept this junction on Mongoose through Task 11 — so a subscription fixture
 * naming a show that does not exist is `23503`, where Mongo stored `'show-1'`
 * happily. Both shows are created per test.
 */
const PODCAST_ID = uuidv7();
const OTHER_PODCAST_ID = uuidv7();
let posted: number;
const realFetch = globalThis.fetch;

beforeAll(connectDb);
afterAll(async () => {
  globalThis.fetch = realFetch;
  await disconnectDb();
});

beforeEach(async () => {
  await getDb()
    .insert(podcasts)
    .values([
      { id: PODCAST_ID, title: 'A Show', source: 'syra' },
      { id: OTHER_PODCAST_ID, title: 'Another Show', source: 'syra' },
    ])
    .onConflictDoNothing();

  posted = 0;
  globalThis.fetch = Object.assign(
    async () => {
      posted += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    },
    { preconnect: realFetch.preconnect },
  );
});

afterEach(clearDb);

async function subscribe(oxyUserId: string, podcastId: string) {
  await getDb().insert(userPodcastSubscriptions).values({ oxyUserId, podcastId });
}

function episode(pubDate: Date | undefined) {
  return {
    episodeId: `ep-${Math.random()}`,
    podcastId: PODCAST_ID,
    podcastTitle: 'A Show',
    episodeTitle: 'An Episode',
    pubDate,
  };
}

describe('notifySubscribersOfNewEpisode', () => {
  it('skips an episode older than the age gate without querying subscribers', async () => {
    await subscribe('u1', PODCAST_ID);

    const old = new Date(Date.now() - EPISODE_NOTIFY_MAX_AGE_MS - 1000);
    const outcome = await notifySubscribersOfNewEpisode(episode(old), Date.now(), testDeps);

    expect(outcome).toEqual({ notified: 0, skippedAsBackfill: true, skippedAsHidden: false });
    expect(posted).toBe(0);
  });

  it('treats an episode with no publish date as backfill', async () => {
    await subscribe('u1', PODCAST_ID);

    const outcome = await notifySubscribersOfNewEpisode(episode(undefined), Date.now(), testDeps);

    expect(outcome.skippedAsBackfill).toBe(true);
    expect(posted).toBe(0);
  });

  it('notifies every subscriber of a genuinely new episode, and nobody else', async () => {
    await subscribe('u1', PODCAST_ID);
    await subscribe('u2', PODCAST_ID);
    await subscribe('u3', OTHER_PODCAST_ID);

    const outcome = await notifySubscribersOfNewEpisode(episode(new Date()), Date.now(), testDeps);

    expect(outcome).toEqual({ notified: 2, skippedAsBackfill: false, skippedAsHidden: false });
    expect(posted).toBe(2);
  });

  it('a whole archive import notifies nobody', async () => {
    await subscribe('u1', PODCAST_ID);

    // 40 back-catalogue episodes, exactly the scenario that would burn the push permission.
    // Each is strictly older than the gate — an episode exactly AT the threshold counts as
    // fresh, since the gate is `>` not `>=`.
    for (let i = 1; i <= 40; i += 1) {
      const old = new Date(Date.now() - EPISODE_NOTIFY_MAX_AGE_MS - i * 1000);
      await notifySubscribersOfNewEpisode(episode(old), Date.now(), testDeps);
    }

    expect(posted).toBe(0);
  });
});
