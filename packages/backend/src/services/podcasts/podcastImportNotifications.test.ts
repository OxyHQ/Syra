import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { eq } from 'drizzle-orm';
import type { SafeFetchResult } from '@oxy.so/core/server';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { userPodcastSubscriptions } from '../../db/schema/library';
import { episodes } from '../../db/schema/podcasts';
import { setCatalogImageMirrorImplementationForTests } from '../catalog/catalogImageAssets';
import type { PublishedEpisode } from '../notifications/triggers/episodePublished';
import { importFeed } from './podcastImportService';

/**
 * Proves the INSERT SIGNAL that drives episode notifications.
 *
 * `importedEpisodes` counts episodes PROCESSED, so every refresh re-processes the whole
 * feed — driving notifications off it would push every episode to every subscriber on
 * every refresh. The import instead asks the DATABASE whether the upsert actually
 * created a row: Postgres answers with `xmax = 0` on the returned row
 * (`db/podcasts/episodes.ts`), which is correct even under two concurrent crawls of
 * one feed.
 *
 * These tests record which episodes the import hands to the new-episode fan-out
 * (`announceEpisode`, injected) rather than asserting on delivered pushes: whether and
 * how a push is delivered is the notifier's concern (`notifier.test.ts`); the decision
 * under test here is the import's, to call the fan-out or not.
 *
 * The whole path — feed, episodes, subscriptions, notifier — is Postgres.
 */

const SUBSCRIBER = 'oxy-subscriber-1';

/** A feed whose episode is fresh enough to clear the 48h age gate. */
function feedWithFreshEpisode(guid: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Fresh Show</title>
    <itunes:author>An Author</itunes:author>
    <item>
      <title>A Brand New Episode</title>
      <guid>${guid}</guid>
      <enclosure url="https://cdn.example/${guid}.mp3" type="audio/mpeg"/>
      <pubDate>${new Date().toUTCString()}</pubDate>
    </item>
  </channel>
</rss>`;
}

function fakeFetchFor(feed: string) {
  return async (): Promise<SafeFetchResult> => ({
    status: 200,
    headers: {},
    finalUrl: 'https://feeds.example/fresh.xml',
    response: Readable.from([Buffer.from(feed, 'utf-8')]) as unknown as IncomingMessage,
  });
}

beforeAll(connectDb);
afterEach(async () => {
  await clearDb();
  setCatalogImageMirrorImplementationForTests();
});
afterAll(disconnectDb);

/** Records every episode the import hands to the fan-out. */
function recordingAnnouncer() {
  const announced: PublishedEpisode[] = [];
  const announceEpisode = async (episode: PublishedEpisode) => {
    announced.push(episode);
    return { notified: 1, skippedAsBackfill: false, skippedAsHidden: false };
  };
  return { announced, announceEpisode };
}

/** How many episode rows a show has — the "did the row really land" read. */
async function episodeCount(podcastId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: episodes.id })
    .from(episodes)
    .where(eq(episodes.podcastId, podcastId));
  return rows.length;
}

describe('episode notifications are driven by the INSERT signal', () => {
  it('notifies on the first import and NOT on a re-import of the same feed', async () => {
    const feedUrl = 'https://feeds.example/fresh.xml';
    const fetch = fakeFetchFor(feedWithFreshEpisode('fresh-ep-1'));

    // First import creates the show; subscribe, then import again so the episode insert
    // has an audience. (The very first run has no subscribers by construction — and the
    // subscription cannot be created before the show exists, since `podcast_id` is a real
    // foreign key now, so this ordering is load-bearing rather than merely convenient.)
    const first = await importFeed(feedUrl, { fetch });
    await getDb()
      .insert(userPodcastSubscriptions)
      .values({ oxyUserId: SUBSCRIBER, podcastId: first.podcast.id });
    await getDb().delete(episodes).where(eq(episodes.podcastId, first.podcast.id));

    // This run genuinely INSERTS the episode → the trigger must run.
    const inserting = recordingAnnouncer();
    const insertRun = await importFeed(feedUrl, {
      fetch,
      force: true,
      announceEpisode: inserting.announceEpisode,
    });
    expect(insertRun.importedEpisodes).toBe(1);
    expect(inserting.announced.map((episode) => episode.podcastId)).toEqual([first.podcast.id]);

    // This run processes the SAME episode again — an update, not an insert. The fan-out
    // is a fresh recorder with nothing downstream to dedupe, so the ONLY thing that can
    // keep it empty is the import deciding not to call it. (Verified by mutation:
    // announcing every processed episode fails this assertion.)
    const reimporting = recordingAnnouncer();
    const reimport = await importFeed(feedUrl, {
      fetch,
      force: true,
      announceEpisode: reimporting.announceEpisode,
    });
    expect(reimport.importedEpisodes).toBe(1); // still PROCESSED one episode...
    expect(reimporting.announced).toEqual([]); // ...but the trigger never ran.
  });

  it('completes the import even though notification delivery fails', async () => {
    const feedUrl = 'https://feeds.example/fresh.xml';
    const fetch = fakeFetchFor(feedWithFreshEpisode('fresh-ep-2'));

    const first = await importFeed(feedUrl, { fetch });
    await getDb()
      .insert(userPodcastSubscriptions)
      .values({ oxyUserId: SUBSCRIBER, podcastId: first.podcast.id });
    await getDb().delete(episodes).where(eq(episodes.podcastId, first.podcast.id));

    // The fan-out itself fails. The import is the only external ingest Syra has — it
    // must survive that completely.
    const result = await importFeed(feedUrl, {
      fetch,
      force: true,
      announceEpisode: async () => {
        throw new Error('fan-out down');
      },
    });

    expect(result.importedEpisodes).toBe(1);
    expect(result.failedEpisodes).toBe(0);
    expect(await episodeCount(first.podcast.id)).toBe(1);
    // The show's bookkeeping still got persisted after the fan-out ran.
    expect(result.podcast.lastRefreshedAt).toBeDefined();
  });
});
