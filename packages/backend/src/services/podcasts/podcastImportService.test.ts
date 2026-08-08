import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { SafeFetchResult } from '@oxyhq/core/server';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { imageAssets } from '../../db/schema/catalog';
import { findPodcastById } from '../../db/podcasts/podcasts';
import { toPodcastDtos } from '../../db/podcasts/hydrate';
import { setCatalogImageMirrorImplementationForTests } from '../catalog/catalogImageAssets';
import { importFeed } from './podcastImportService';
import type { PodcastDirectoryCandidate } from './PodcastDirectory';

beforeAll(connectDb);
afterEach(async () => {
  await clearDb();
  setCatalogImageMirrorImplementationForTests(); // restore real mirror
});
afterAll(disconnectDb);

const SYRA_IMAGE_ID = '5f9d88b9c1f4e2a3b4c5d6e7';
const EXTERNAL_COVER = 'https://image.simplecastcdn.com/the-daily-cover.jpg';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>The Daily</title>
    <itunes:author>The New York Times</itunes:author>
    <itunes:image href="${EXTERNAL_COVER}"/>
    <item>
      <title>Episode One</title>
      <guid>ep-1</guid>
      <enclosure url="https://cdn.example/ep1.mp3" type="audio/mpeg"/>
      <pubDate>Wed, 01 Jan 2025 08:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

async function fakeFetch(): Promise<SafeFetchResult> {
  return {
    status: 200,
    headers: {},
    finalUrl: 'https://feeds.example/daily.xml',
    response: Readable.from([Buffer.from(FEED, 'utf-8')]) as unknown as IncomingMessage,
  };
}

/**
 * The mirrored asset has to EXIST as a row.
 *
 * `podcasts.image_id` is a foreign key to `image_assets`, where Mongo stored
 * whatever string the mirror returned. In production the real mirror creates
 * that row (`services/imageAssetService.ts`) before returning its id, so nothing
 * changes there; here the mirror is STUBBED, so the fixture has to create it —
 * a stub returning an id nothing backs fails the import with `23503` and looks
 * like a bug in the code under test.
 *
 * `width`/`height` are not decoration either: `imageVariantLookup` skips an
 * asset missing dimensions, so without them `imageSizes` comes back empty and
 * the DTO assertion below fails for a reason unrelated to re-hosting.
 */
async function seedMirroredAsset(): Promise<void> {
  await getDb()
    .insert(imageAssets)
    .values({
      id: SYRA_IMAGE_ID,
      s3Key: `images/${SYRA_IMAGE_ID}.jpg`,
      filename: 'the-daily-cover.jpg',
      contentType: 'image/jpeg',
      byteSize: 1024,
      ownerType: 'podcast',
      width: 640,
      height: 640,
      primaryColor: '#123456',
      secondaryColor: '#654321',
    })
    .onConflictDoNothing();
}

const candidate: PodcastDirectoryCandidate = {
  feedUrl: 'https://feeds.example/daily.xml',
  title: 'The Daily',
  author: 'The New York Times',
  image: EXTERNAL_COVER,
  categories: [],
};

/**
 * Three categories whose feed order is NOT their alphabetical order.
 *
 * That is the whole point of the fixture: `podcast_categories` originally had no
 * `position` column and the read ordered by name, so a fixture whose feed order
 * happened to be alphabetical would pass either way. `News` first is also what
 * RSS means by the primary category, so this is the real shape.
 */
const ORDERED_CATEGORIES = ['News', 'Daily News', 'Business'];

describe('importFeed — cover re-host (search/bulk-import deep path)', () => {
  it('replaces the external cover URL with a Syra S3 image id + sizes + primaryColor', async () => {
    await seedMirroredAsset();
    setCatalogImageMirrorImplementationForTests(async (_images, context) => {
      expect(context.entityType).toBe('podcast'); // re-host runs as a podcast cover
      return {
        imageId: SYRA_IMAGE_ID,
        imageSizes: { large: { id: SYRA_IMAGE_ID, url: `/api/images/${SYRA_IMAGE_ID}`, width: 640, height: 640 } },
        primaryColor: '#123456',
        secondaryColor: '#654321',
        sourceUrlHash: 'u',
        sourceContentHash: 'c',
      };
    });

    const result = await importFeed(candidate.feedUrl, { directory: candidate, fetch: fakeFetch });

    const row = await findPodcastById(result.podcast.id);
    expect(row).toBeDefined();
    if (!row) return;
    // The stored value is the bare asset id, NOT the external CDN url.
    expect(row.imageId).toBe(SYRA_IMAGE_ID);
    expect(row.imageId).not.toBe(EXTERNAL_COVER);
    expect(row.imageSizesLargeId).toBe(SYRA_IMAGE_ID);
    expect(row.primaryColor).toBe('#123456');
    // The external URL is kept only as a fallback.
    expect(row.imageSourceUrl).toBe(EXTERNAL_COVER);
    // Deep import done → flag cleared.
    expect(row.needsDeepImport).toBe(false);

    // And on the wire the id is resolved to its `/api/images/:id` path plus the
    // rendered variant — what a client actually renders, which the raw column
    // cannot show and which the seven-FK layout has to reassemble.
    const [dto] = await toPodcastDtos([row]);
    expect(dto?.image).toBe(`/api/images/${SYRA_IMAGE_ID}`);
    expect(dto?.imageSizes?.large).toEqual({
      id: SYRA_IMAGE_ID,
      url: `/api/images/${SYRA_IMAGE_ID}`,
      width: 640,
      height: 640,
    });
  });

  it('keeps the external URL as a fallback when re-hosting fails (never stores it in `image`)', async () => {
    setCatalogImageMirrorImplementationForTests(async () => undefined); // mirror fails

    const result = await importFeed(candidate.feedUrl, { directory: candidate, fetch: fakeFetch });

    const row = await findPodcastById(result.podcast.id);
    expect(row?.imageId).toBeNull(); // never the external URL
    expect(row?.imageSourceUrl).toBe(EXTERNAL_COVER);
  });

  it('mirrors the feed into rows, not just a show — episodes and the recomputed counters', async () => {
    setCatalogImageMirrorImplementationForTests(async () => undefined);

    const result = await importFeed(candidate.feedUrl, { directory: candidate, fetch: fakeFetch });

    expect(result.importedEpisodes).toBe(1);
    expect(result.failedEpisodes).toBe(0);

    /**
     * `episode_count` and `last_episode_at` are recomputed FROM the episode rows
     * at the end of the crawl, so this is what says the episodes really landed
     * in their own table rather than the import merely reporting that they did —
     * which is exactly what a half-ported writer looks like from the outside.
     */
    const row = await findPodcastById(result.podcast.id);
    expect(row?.episodeCount).toBe(1);
    expect(row?.lastEpisodeAt?.toISOString()).toBe('2025-01-01T08:00:00.000Z');
  });

  it('keeps the feed\'s category order, which is not alphabetical order', async () => {
    setCatalogImageMirrorImplementationForTests(async () => undefined);

    const result = await importFeed(candidate.feedUrl, {
      directory: { ...candidate, categories: ORDERED_CATEGORIES },
      fetch: fakeFetch,
    });

    const row = await findPodcastById(result.podcast.id);
    expect(row).toBeDefined();
    if (!row) return;

    const [dto] = await toPodcastDtos([row]);
    // Feed order, not `['Business', 'Daily News', 'News']` — which is what an
    // ordering by name returns, and what this assertion would have got before
    // `position` existed.
    expect(dto?.categories).toEqual(ORDERED_CATEGORIES);
  });

  it('re-crawling reassigns positions rather than colliding on them', async () => {
    /**
     * `podcast_categories_podcast_id_position_key` makes a naive append fail
     * on the second crawl, so this is the idempotency check for the new column
     * specifically: `setPodcastCategories` deletes before inserting, and the
     * reordered feed has to land in its NEW order rather than the stored one.
     */
    setCatalogImageMirrorImplementationForTests(async () => undefined);

    await importFeed(candidate.feedUrl, {
      directory: { ...candidate, categories: ORDERED_CATEGORIES },
      fetch: fakeFetch,
    });
    const reordered = [...ORDERED_CATEGORIES].reverse();
    const second = await importFeed(candidate.feedUrl, {
      directory: { ...candidate, categories: reordered },
      fetch: fakeFetch,
    });

    const row = await findPodcastById(second.podcast.id);
    expect(row).toBeDefined();
    if (!row) return;

    const [dto] = await toPodcastDtos([row]);
    expect(dto?.categories).toEqual(reordered);
  });

  it('is idempotent: a second crawl updates rather than duplicating', async () => {
    setCatalogImageMirrorImplementationForTests(async () => undefined);

    const first = await importFeed(candidate.feedUrl, { directory: candidate, fetch: fakeFetch });
    const second = await importFeed(candidate.feedUrl, { directory: candidate, fetch: fakeFetch });

    /**
     * Same show row, and still exactly one episode.
     *
     * This is the detector the module's own doc comment argues for: a write that
     * never lands is redone on the next pass, so a second crawl is what tells a
     * real upsert from a reported one. `unique(podcast_id, guid)` makes the
     * re-crawl an update, and `episode_count` is READ BACK from the table rather
     * than incremented, so a duplicate row would show up here as `2`.
     */
    expect(second.podcast.id).toBe(first.podcast.id);
    expect((await findPodcastById(second.podcast.id))?.episodeCount).toBe(1);
  });
});
