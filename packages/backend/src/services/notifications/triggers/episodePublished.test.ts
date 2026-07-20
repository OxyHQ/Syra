import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { clear, connect, disconnect } from '../../../test/mongo';
import { UserLibraryModel } from '../../../models/Library';
import { EPISODE_NOTIFY_MAX_AGE_MS, notifySubscribersOfNewEpisode } from './episodePublished';

/** Injected so the trigger tests exercise fan-out, not the credential-absent path. */
const testDeps = { getToken: async () => 'test-service-token' };

/**
 * The age gate is the half of the anti-spam design that coalescing cannot provide:
 * importing an archive must notify NOBODY, however many subscribers the show has.
 */

const PODCAST_ID = 'show-1';
let posted: number;
const realFetch = globalThis.fetch;

beforeAll(connect);
afterAll(async () => {
  globalThis.fetch = realFetch;
  await disconnect();
});

beforeEach(() => {
  posted = 0;
  globalThis.fetch = Object.assign(
    async () => {
      posted += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    },
    { preconnect: realFetch.preconnect },
  );
});

afterEach(clear);

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
    await UserLibraryModel.create({ oxyUserId: 'u1', subscribedPodcasts: [PODCAST_ID] });

    const old = new Date(Date.now() - EPISODE_NOTIFY_MAX_AGE_MS - 1000);
    const outcome = await notifySubscribersOfNewEpisode(episode(old), Date.now(), testDeps);

    expect(outcome).toEqual({ notified: 0, skippedAsBackfill: true });
    expect(posted).toBe(0);
  });

  it('treats an episode with no publish date as backfill', async () => {
    await UserLibraryModel.create({ oxyUserId: 'u1', subscribedPodcasts: [PODCAST_ID] });

    const outcome = await notifySubscribersOfNewEpisode(episode(undefined), Date.now(), testDeps);

    expect(outcome.skippedAsBackfill).toBe(true);
    expect(posted).toBe(0);
  });

  it('notifies every subscriber of a genuinely new episode, and nobody else', async () => {
    await UserLibraryModel.create({ oxyUserId: 'u1', subscribedPodcasts: [PODCAST_ID] });
    await UserLibraryModel.create({ oxyUserId: 'u2', subscribedPodcasts: [PODCAST_ID] });
    await UserLibraryModel.create({ oxyUserId: 'u3', subscribedPodcasts: ['some-other-show'] });

    const outcome = await notifySubscribersOfNewEpisode(episode(new Date()), Date.now(), testDeps);

    expect(outcome).toEqual({ notified: 2, skippedAsBackfill: false });
    expect(posted).toBe(2);
  });

  it('a whole archive import notifies nobody', async () => {
    await UserLibraryModel.create({ oxyUserId: 'u1', subscribedPodcasts: [PODCAST_ID] });

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
