import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { SafeFetchResult } from '@oxy.so/core/server';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';
import { episodes, podcasts } from '../db/schema/podcasts';
import { setCatalogImageMirrorImplementationForTests } from '../services/catalog/catalogImageAssets';
import { backfillEpisodeImages } from './backfillEpisodeImages';

beforeAll(connectDb);
afterEach(async () => {
  await clearDb();
  setCatalogImageMirrorImplementationForTests(); // restore real mirror
});
afterAll(disconnectDb);

const SHOW_COVER = 'https://image.simplecastcdn.com/the-daily-cover.jpg';
const EPISODE_COVER = 'https://image.simplecastcdn.com/episode-one-cover.jpg';
const EPISODE_IMAGE_ID = '5f9d88b9c1f4e2a3b4c5d6e8';

function feed(itemImage?: string, guid = 'ep-1'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>The Daily</title>
    <itunes:image href="${SHOW_COVER}"/>
    <item>
      <title>Episode One</title>
      <guid>${guid}</guid>
      ${itemImage ? `<itunes:image href="${itemImage}"/>` : ''}
      <enclosure url="https://cdn.example/ep1.mp3" type="audio/mpeg"/>
      <pubDate>Wed, 01 Jan 2025 08:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;
}

function fakeFetchOf(body: string) {
  return async (): Promise<SafeFetchResult> => ({
    status: 200,
    headers: {},
    finalUrl: 'https://feeds.example/daily.xml',
    response: Readable.from([Buffer.from(body, 'utf-8')]) as unknown as IncomingMessage,
  });
}

/** An `rss` show, inserted directly — this suite is about the script, not `importFeed`. */
async function makePodcast(overrides: Partial<typeof podcasts.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(podcasts)
    .values({
      title: 'The Daily',
      source: 'rss',
      status: 'active',
      feedUrl: 'https://feeds.example/daily.xml',
      ...overrides,
    })
    .returning({ id: podcasts.id });
  if (!row) throw new Error('makePodcast: insert returned no row');
  return row.id;
}

async function makeEpisode(
  podcastId: string,
  overrides: Partial<typeof episodes.$inferInsert> = {}
): Promise<string> {
  const [row] = await getDb()
    .insert(episodes)
    .values({
      podcastId,
      podcastTitle: 'The Daily',
      title: 'Episode One',
      guid: 'ep-1',
      pubDate: new Date('2025-01-01T08:00:00Z'),
      source: 'rss',
      status: 'ready',
      cacheStatus: 'none',
      playCount: 0,
      popularity: 0,
      ...overrides,
    })
    .returning({ id: episodes.id });
  if (!row) throw new Error('makeEpisode: insert returned no row');
  return row.id;
}

async function readEpisode(id: string) {
  const [row] = await getDb().select().from(episodes).where(eq(episodes.id, id)).limit(1);
  return row;
}

/** Same rationale as `podcastImportService.test.ts`'s `seedMirroredAsset`. */
async function seedEpisodeMirroredAsset(): Promise<void> {
  await getDb()
    .insert(imageAssets)
    .values({
      id: EPISODE_IMAGE_ID,
      s3Key: `images/${EPISODE_IMAGE_ID}.jpg`,
      filename: 'episode-one-cover.jpg',
      contentType: 'image/jpeg',
      byteSize: 1024,
      ownerType: 'podcast',
      width: 640,
      height: 640,
      primaryColor: '#abcdef',
      secondaryColor: '#fedcba',
    })
    .onConflictDoNothing();
}

describe('backfillEpisodeImages', () => {
  it("fixes an episode stuck at imageId: null, without touching the show's own cover", async () => {
    await seedEpisodeMirroredAsset();
    setCatalogImageMirrorImplementationForTests(async () => ({
      imageId: EPISODE_IMAGE_ID,
      imageSizes: {
        large: { id: EPISODE_IMAGE_ID, url: `/api/images/${EPISODE_IMAGE_ID}`, width: 640, height: 640 },
      },
      primaryColor: '#abcdef',
      secondaryColor: '#fedcba',
      sourceUrlHash: 'u',
      sourceContentHash: 'c',
    }));

    const podcastId = await makePodcast();
    const episodeId = await makeEpisode(podcastId, { imageId: null });

    const stats = await backfillEpisodeImages({ fetch: fakeFetchOf(feed(EPISODE_COVER)) });

    expect(stats.episodesFixed).toBe(1);
    expect(stats.episodesFailed).toBe(0);

    const row = await readEpisode(episodeId);
    expect(row?.imageId).toBe(EPISODE_IMAGE_ID);
    expect(row?.imageSourceUrl).toBe(EPISODE_COVER);
  });

  it("does not re-fetch the feed at all when every episode already has its own cover", async () => {
    await seedEpisodeMirroredAsset(); // the episode row below FKs to it
    let mirrorCalls = 0;
    setCatalogImageMirrorImplementationForTests(async () => {
      mirrorCalls += 1;
      return undefined;
    });
    let fetchCalls = 0;
    const countingFetch = async (): Promise<SafeFetchResult> => {
      fetchCalls += 1;
      return fakeFetchOf(feed(EPISODE_COVER))();
    };

    const podcastId = await makePodcast();
    await makeEpisode(podcastId, { imageId: EPISODE_IMAGE_ID });

    const stats = await backfillEpisodeImages({ fetch: countingFetch });

    expect(stats.podcastsSkipped).toBe(1);
    expect(stats.podcastsScanned).toBe(1);
    expect(fetchCalls).toBe(0); // no feed I/O for a show with nothing missing
    expect(mirrorCalls).toBe(0);
  });

  it("skips an episode whose art is the same URL as the show's", async () => {
    setCatalogImageMirrorImplementationForTests(async () => {
      throw new Error('the mirror must not be called for art identical to the show cover');
    });

    const podcastId = await makePodcast();
    const episodeId = await makeEpisode(podcastId, { imageId: null });

    // The item's own <itunes:image> is the SAME url as the channel's.
    const stats = await backfillEpisodeImages({ fetch: fakeFetchOf(feed(SHOW_COVER)) });

    expect(stats.episodesNoDistinctArt).toBe(1);
    expect(stats.episodesFixed).toBe(0);

    const row = await readEpisode(episodeId);
    expect(row?.imageId).toBeNull();
  });

  it('leaves the database untouched in --dry-run, but still reports what it would fix', async () => {
    let mirrorCalls = 0;
    setCatalogImageMirrorImplementationForTests(async () => {
      mirrorCalls += 1;
      return undefined;
    });

    const podcastId = await makePodcast();
    const episodeId = await makeEpisode(podcastId, { imageId: null });

    const stats = await backfillEpisodeImages({ dryRun: true, fetch: fakeFetchOf(feed(EPISODE_COVER)) });

    expect(stats.episodesFixed).toBe(1);
    expect(mirrorCalls).toBe(0); // never even attempts the network fetch

    const row = await readEpisode(episodeId);
    expect(row?.imageId).toBeNull(); // nothing written
  });

  it('counts an episode whose guid has left the feed, without touching its row', async () => {
    const podcastId = await makePodcast();
    const episodeId = await makeEpisode(podcastId, { guid: 'ep-vanished', imageId: null });

    // The feed's only item is a DIFFERENT guid.
    const stats = await backfillEpisodeImages({ fetch: fakeFetchOf(feed(EPISODE_COVER, 'ep-1')) });

    expect(stats.episodesGoneFromFeed).toBe(1);
    expect(stats.episodesFixed).toBe(0);

    const row = await readEpisode(episodeId);
    expect(row?.imageId).toBeNull();
  });

  it('records a re-host failure and keeps the raw URL as a fallback, without crashing the run', async () => {
    setCatalogImageMirrorImplementationForTests(async () => undefined); // mirror fails

    const podcastId = await makePodcast();
    const episodeId = await makeEpisode(podcastId, { imageId: null });

    const stats = await backfillEpisodeImages({ fetch: fakeFetchOf(feed(EPISODE_COVER)) });

    expect(stats.episodesFailed).toBe(1);
    expect(stats.episodesFixed).toBe(0);

    const row = await readEpisode(episodeId);
    expect(row?.imageId).toBeNull();
    expect(row?.imageSourceUrl).toBe(EPISODE_COVER);
  });

  it('does not abort the run when one feed fails to fetch — later podcasts still get fixed', async () => {
    await seedEpisodeMirroredAsset();
    setCatalogImageMirrorImplementationForTests(async () => ({
      imageId: EPISODE_IMAGE_ID,
      imageSizes: {
        large: { id: EPISODE_IMAGE_ID, url: `/api/images/${EPISODE_IMAGE_ID}`, width: 640, height: 640 },
      },
      sourceUrlHash: 'u',
      sourceContentHash: 'c',
    }));

    const brokenPodcastId = await makePodcast({ feedUrl: 'https://feeds.example/broken.xml' });
    await makeEpisode(brokenPodcastId, { guid: `ep-${uuidv7()}`, imageId: null });

    const healthyPodcastId = await makePodcast({ feedUrl: 'https://feeds.example/daily.xml' });
    const healthyEpisodeId = await makeEpisode(healthyPodcastId, { imageId: null });

    let calls = 0;
    const flakyFetch = async (url: string): Promise<SafeFetchResult> => {
      calls += 1;
      if (url === 'https://feeds.example/broken.xml') {
        throw new Error('simulated upstream failure');
      }
      return fakeFetchOf(feed(EPISODE_COVER))();
    };

    const stats = await backfillEpisodeImages({ fetch: flakyFetch });

    expect(calls).toBe(2);
    expect(stats.podcastsFailed).toBe(1);
    expect(stats.episodesFixed).toBe(1);

    const healthyRow = await readEpisode(healthyEpisodeId);
    expect(healthyRow?.imageId).toBe(EPISODE_IMAGE_ID);
  });
});
