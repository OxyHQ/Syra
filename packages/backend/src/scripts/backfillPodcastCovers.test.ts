import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { SafeFetchResult } from '@oxy.so/core/server';
import { eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';
import { podcasts } from '../db/schema/podcasts';
import { setCatalogImageMirrorImplementationForTests } from '../services/catalog/catalogImageAssets';
import { backfillPodcastCovers } from './backfillPodcastCovers';

beforeAll(connectDb);
afterEach(async () => {
  await clearDb();
  setCatalogImageMirrorImplementationForTests(); // restore real mirror
});
afterAll(disconnectDb);

const SHOW_COVER = 'https://image.simplecastcdn.com/the-daily-cover.jpg';
const REHOSTED_IMAGE_ID = '01a0a454-1e9e-78e9-8261-2b689cc477e9';

function feed(showImage?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>The Daily</title>
    ${showImage ? `<itunes:image href="${showImage}"/>` : ''}
    <item>
      <title>Episode One</title>
      <guid>ep-1</guid>
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

async function makeCoverlessPodcast(
  overrides: Partial<typeof podcasts.$inferInsert> = {}
): Promise<string> {
  const [row] = await getDb()
    .insert(podcasts)
    .values({
      title: 'The Daily',
      source: 'rss',
      status: 'active',
      feedUrl: 'https://feeds.example/daily.xml',
      imageId: null,
      ...overrides,
    })
    .returning({ id: podcasts.id });
  if (!row) throw new Error('makeCoverlessPodcast: insert returned no row');
  return row.id;
}

async function readPodcast(id: string) {
  const [row] = await getDb().select().from(podcasts).where(eq(podcasts.id, id)).limit(1);
  return row;
}

/** `podcasts.image_id` FKs to a real row — the mock mirror's returned id must exist. */
async function seedImageAsset(id: string): Promise<void> {
  await getDb()
    .insert(imageAssets)
    .values({
      id,
      s3Key: `images/${id}.jpg`,
      filename: `${id}.jpg`,
      contentType: 'image/jpeg',
      byteSize: 1024,
      ownerType: 'podcast',
      width: 640,
      height: 640,
    })
    .onConflictDoNothing();
}

describe('backfillPodcastCovers', () => {
  it('re-hosts a stuck show cover on a forced full parse', async () => {
    await seedImageAsset(REHOSTED_IMAGE_ID);
    setCatalogImageMirrorImplementationForTests(async () => ({
      imageId: REHOSTED_IMAGE_ID,
      imageSizes: {
        large: { id: REHOSTED_IMAGE_ID, url: `/api/images/${REHOSTED_IMAGE_ID}`, width: 640, height: 640 },
      },
      primaryColor: '#abcdef',
      secondaryColor: '#fedcba',
      sourceUrlHash: 'u',
      sourceContentHash: 'c',
    }));

    const podcastId = await makeCoverlessPodcast({
      imageSourceUrl: 'https://stale-directory-thumbnail.example/old.jpg',
    });

    const stats = await backfillPodcastCovers({ fetch: fakeFetchOf(feed(SHOW_COVER)) });

    expect(stats.podcastsFixed).toBe(1);
    expect(stats.podcastsNoArt).toBe(0);
    expect(stats.podcastsFailed).toBe(0);

    const row = await readPodcast(podcastId);
    expect(row?.imageId).toBe(REHOSTED_IMAGE_ID);
    expect(row?.imageSourceUrl).toBe(SHOW_COVER);
  });

  it('does not scan a podcast that already has a cover', async () => {
    let fetchCalls = 0;
    const countingFetch = async (): Promise<SafeFetchResult> => {
      fetchCalls += 1;
      return fakeFetchOf(feed(SHOW_COVER))();
    };

    const existingImageId = '01a0a454-0000-7000-8000-000000000000';
    await seedImageAsset(existingImageId);
    await makeCoverlessPodcast({ imageId: existingImageId });

    const stats = await backfillPodcastCovers({ fetch: countingFetch });

    expect(stats.podcastsScanned).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it('counts a feed with no show art at all as podcastsNoArt, not fixed', async () => {
    setCatalogImageMirrorImplementationForTests(async () => {
      throw new Error('the mirror must not be called when the feed has no show image');
    });

    const podcastId = await makeCoverlessPodcast();

    const stats = await backfillPodcastCovers({ fetch: fakeFetchOf(feed(undefined)) });

    expect(stats.podcastsFixed).toBe(0);
    expect(stats.podcastsNoArt).toBe(1);
    expect(stats.podcastsFailed).toBe(0);

    const row = await readPodcast(podcastId);
    expect(row?.imageId).toBeNull();
  });

  it('counts a feed fetch failure as podcastsFailed, leaving the row untouched', async () => {
    const podcastId = await makeCoverlessPodcast({
      imageSourceUrl: 'https://stale-directory-thumbnail.example/old.jpg',
    });

    const stats = await backfillPodcastCovers({
      fetch: async () => {
        throw new Error('network down');
      },
    });

    expect(stats.podcastsFixed).toBe(0);
    expect(stats.podcastsFailed).toBe(1);

    const row = await readPodcast(podcastId);
    expect(row?.imageId).toBeNull();
    expect(row?.imageSourceUrl).toBe('https://stale-directory-thumbnail.example/old.jpg');
  });

  it('--dry-run scans without writing anything', async () => {
    setCatalogImageMirrorImplementationForTests(async () => {
      throw new Error('dry run must never re-host anything');
    });

    const podcastId = await makeCoverlessPodcast();

    const stats = await backfillPodcastCovers({ dryRun: true, fetch: fakeFetchOf(feed(SHOW_COVER)) });

    expect(stats.podcastsScanned).toBe(1);
    expect(stats.podcastsFixed).toBe(0);

    const row = await readPodcast(podcastId);
    expect(row?.imageId).toBeNull();
  });

  it('running twice is a no-op the second time', async () => {
    await seedImageAsset(REHOSTED_IMAGE_ID);
    setCatalogImageMirrorImplementationForTests(async () => ({
      imageId: REHOSTED_IMAGE_ID,
      imageSizes: {
        large: { id: REHOSTED_IMAGE_ID, url: `/api/images/${REHOSTED_IMAGE_ID}`, width: 640, height: 640 },
      },
      sourceUrlHash: 'u',
      sourceContentHash: 'c',
    }));
    await makeCoverlessPodcast();

    await backfillPodcastCovers({ fetch: fakeFetchOf(feed(SHOW_COVER)) });
    const second = await backfillPodcastCovers({ fetch: fakeFetchOf(feed(SHOW_COVER)) });

    expect(second.podcastsScanned).toBe(0);
  });
});
