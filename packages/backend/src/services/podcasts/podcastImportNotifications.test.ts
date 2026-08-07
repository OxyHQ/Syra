import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { eq } from 'drizzle-orm';
import type { SafeFetchResult } from '@oxyhq/core/server';
import { clear, connect, disconnect } from '../../test/mongo';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { userPodcastSubscriptions } from '../../db/schema/library';
import { episodes } from '../../db/schema/podcasts';
import { NotificationSuppressionModel } from '../../models/NotificationSuppression';
import { setCatalogImageMirrorImplementationForTests } from '../catalog/catalogImageAssets';
import { importFeed } from './podcastImportService';

/**
 * Proves the INSERT SIGNAL that drives episode notifications.
 *
 * `importedEpisodes` counts episodes PROCESSED, so every refresh re-processes the whole
 * feed — driving notifications off it would push every episode to every subscriber on
 * every refresh. The import instead asks the DATABASE whether the upsert actually
 * created a row: Mongo answered with `updatedExisting: false`, Postgres answers with
 * `xmax = 0` on the returned row (`db/podcasts/episodes.ts`). Same question, and the
 * Postgres form is additionally correct under two concurrent crawls of one feed.
 *
 * These tests assert on NotificationSuppression rows rather than on delivered pushes:
 * the notifier claims its suppression key BEFORE attempting delivery, so a claim proves
 * the trigger genuinely ran for that episode. Delivery itself cannot succeed here — no
 * Oxy service credentials are configured in tests — which is exactly what makes the
 * second test meaningful.
 *
 * ## This suite spans BOTH databases, deliberately
 *
 * Subscriptions and episodes are Postgres since Task 12; the notifier's suppression
 * ledger is still Mongoose, because `notification_suppressions` exists in
 * `schema/user.ts` but nothing writes it yet. That split is the production reality
 * today, so the test connects to both rather than stubbing one out — a stub here would
 * assert against the seam instead of across it.
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

beforeAll(async () => {
  await connect();
  await connectDb();
});
afterEach(async () => {
  await clear();
  await clearDb();
  setCatalogImageMirrorImplementationForTests();
});
afterAll(async () => {
  await disconnect();
  await disconnectDb();
});

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
    await NotificationSuppressionModel.deleteMany({});

    // This run genuinely INSERTS the episode → the trigger must run.
    const inserting = await importFeed(feedUrl, { fetch, force: true });
    expect(inserting.importedEpisodes).toBe(1);
    expect(await NotificationSuppressionModel.countDocuments({ oxyUserId: SUBSCRIBER }))
      .toBeGreaterThan(0);

    // CRITICAL: wipe the suppression records before the re-import. Without this the test
    // has no teeth — the notifier's own exact-entity dedupe would swallow a wrong signal
    // and the counts would match either way. Clearing them means the ONLY thing that can
    // keep the count at zero below is the import correctly deciding not to call the
    // trigger at all. (Verified by mutation: notifying on every processed episode fails
    // this assertion.)
    await NotificationSuppressionModel.deleteMany({});

    // This run processes the SAME episode again — an update, not an insert.
    const reimport = await importFeed(feedUrl, { fetch, force: true });
    expect(reimport.importedEpisodes).toBe(1); // still PROCESSED one episode...
    expect(await NotificationSuppressionModel.countDocuments({ oxyUserId: SUBSCRIBER }))
      .toBe(0); // ...but the trigger never ran, so nothing was claimed.
  });

  it('completes the import even though notification delivery fails', async () => {
    const feedUrl = 'https://feeds.example/fresh.xml';
    const fetch = fakeFetchFor(feedWithFreshEpisode('fresh-ep-2'));

    const first = await importFeed(feedUrl, { fetch });
    await getDb()
      .insert(userPodcastSubscriptions)
      .values({ oxyUserId: SUBSCRIBER, podcastId: first.podcast.id });
    await getDb().delete(episodes).where(eq(episodes.podcastId, first.podcast.id));

    // No Oxy service credentials exist in tests, so every delivery attempt fails. The
    // import is the only external ingest Syra has — it must survive that completely.
    const result = await importFeed(feedUrl, { fetch, force: true });

    expect(result.importedEpisodes).toBe(1);
    expect(result.failedEpisodes).toBe(0);
    expect(await episodeCount(first.podcast.id)).toBe(1);
    // The show's bookkeeping still got persisted after the fan-out ran.
    expect(result.podcast.lastRefreshedAt).toBeDefined();
  });
});
