import { describe, it, expect, beforeAll, afterEach, afterAll, mock } from 'bun:test';
import { eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';
import { episodes, podcasts } from '../db/schema/podcasts';
import * as realS3 from '../services/s3Service';
import { consolidateDuplicateCatalogImages } from './consolidateDuplicateCatalogImages';

const deletedKeyBatches: string[][] = [];

// The real module minus the S3 write, so a bug that reaches actual S3 calls
// in this process would still surface as a real network error rather than
// silently succeeding — only the one function this suite exercises is faked.
// `mock.module` calls are hoisted above every import in the file, so this
// still takes effect before `consolidateDuplicateCatalogImages` above resolves
// its own `s3Service` import.
mock.module('../services/s3Service', () => ({
  ...realS3,
  deleteFromS3Batch: async (keys: readonly string[]): Promise<number> => {
    deletedKeyBatches.push([...keys]);
    return keys.length;
  },
}));

beforeAll(connectDb);
afterEach(async () => {
  await clearDb();
  deletedKeyBatches.length = 0;
});
afterAll(disconnectDb);

const SIZES = ['small', 'medium', 'large', 'xlarge', 'xxlarge', 'original'] as const;

async function makePodcast(overrides: Partial<typeof podcasts.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(podcasts)
    .values({ title: 'The Daily', source: 'rss', status: 'active', feedUrl: 'https://feeds.example/daily.xml', ...overrides })
    .returning({ id: podcasts.id });
  if (!row) throw new Error('makePodcast: insert returned no row');
  return row.id;
}

async function makeEpisode(
  podcastId: string,
  guid: string,
  overrides: Partial<typeof episodes.$inferInsert> = {}
): Promise<string> {
  const [row] = await getDb()
    .insert(episodes)
    .values({
      podcastId,
      podcastTitle: 'The Daily',
      title: `Episode ${guid}`,
      guid,
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

/** One complete six-row mirrored set, as `createImageSizes` stamps one. */
async function seedImageSet(input: {
  externalId: string;
  sourceUrlHash: string;
  sourceContentHash: string;
  createdAt: Date;
}): Promise<Record<(typeof SIZES)[number], string>> {
  const ids: Partial<Record<(typeof SIZES)[number], string>> = {};
  for (const size of SIZES) {
    const [row] = await getDb()
      .insert(imageAssets)
      .values({
        s3Key: `images/${input.externalId}/${size}`,
        filename: `rss-episode-${input.externalId}-${size}`,
        contentType: 'image/webp',
        byteSize: 1000,
        width: 100,
        height: 100,
        ownerType: 'episode',
        catalogProvider: 'rss',
        catalogEntityType: 'episode',
        catalogExternalId: input.externalId,
        catalogSize: size,
        catalogSourceUrlHash: input.sourceUrlHash,
        catalogSourceContentHash: input.sourceContentHash,
        createdAt: input.createdAt,
      })
      .returning({ id: imageAssets.id });
    if (!row) throw new Error('seedImageSet: insert returned no row');
    ids[size] = row.id;
  }
  return ids as Record<(typeof SIZES)[number], string>;
}

async function readEpisodeImageId(id: string): Promise<string | null> {
  const [row] = await getDb().select({ imageId: episodes.imageId }).from(episodes).where(eq(episodes.id, id)).limit(1);
  return row?.imageId ?? null;
}

async function readPodcastImageId(id: string): Promise<string | null> {
  const [row] = await getDb().select({ imageId: podcasts.imageId }).from(podcasts).where(eq(podcasts.id, id)).limit(1);
  return row?.imageId ?? null;
}

async function countImageAssetRows(): Promise<number> {
  const rows = await getDb().select({ id: imageAssets.id }).from(imageAssets);
  return rows.length;
}

describe('consolidateDuplicateCatalogImages', () => {
  it('rewrites every referencing table onto the oldest set, then deletes the duplicate', async () => {
    const podcastId = await makePodcast();
    const episodeOld = await makeEpisode(podcastId, 'ep-old');
    const episodeNew = await makeEpisode(podcastId, 'ep-new');

    const canonical = await seedImageSet({
      externalId: 'ep-old',
      sourceUrlHash: 'url-hash-shared',
      sourceContentHash: 'content-hash-shared',
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const duplicate = await seedImageSet({
      externalId: 'ep-new',
      sourceUrlHash: 'url-hash-shared',
      sourceContentHash: 'content-hash-shared',
      createdAt: new Date('2025-06-01T00:00:00Z'),
    });

    await getDb().update(episodes).set({ imageId: canonical.large }).where(eq(episodes.id, episodeOld));
    await getDb().update(episodes).set({ imageId: duplicate.large }).where(eq(episodes.id, episodeNew));
    // A DIFFERENT table referencing the same duplicate set — proves the rewrite
    // is not scoped to whichever table happened to create it.
    await getDb().update(podcasts).set({ imageId: duplicate.large }).where(eq(podcasts.id, podcastId));

    const stats = await consolidateDuplicateCatalogImages();

    expect(stats.hashGroupsProcessed).toBe(1);
    expect(stats.hashGroupsSkipped).toBe(0);
    expect(stats.rowsDeleted).toBe(6);
    expect(stats.s3ObjectsDeleted).toBe(6);

    expect(await readEpisodeImageId(episodeOld)).toBe(canonical.large ?? null);
    expect(await readEpisodeImageId(episodeNew)).toBe(canonical.large ?? null);
    expect(await readPodcastImageId(podcastId)).toBe(canonical.large ?? null);

    expect(await countImageAssetRows()).toBe(6);
    expect(deletedKeyBatches.flat().sort()).toEqual(
      SIZES.map((size) => `images/ep-new/${size}`).sort()
    );
  });

  it('leaves an image mirrored by only one entity untouched', async () => {
    const podcastId = await makePodcast();
    const episodeId = await makeEpisode(podcastId, 'ep-solo');
    const solo = await seedImageSet({
      externalId: 'ep-solo',
      sourceUrlHash: 'url-hash-solo',
      sourceContentHash: 'content-hash-solo',
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    await getDb().update(episodes).set({ imageId: solo.large }).where(eq(episodes.id, episodeId));

    const stats = await consolidateDuplicateCatalogImages();

    expect(stats.hashGroupsProcessed).toBe(0);
    expect(stats.rowsDeleted).toBe(0);
    expect(await countImageAssetRows()).toBe(6);
    expect(deletedKeyBatches).toEqual([]);
  });

  it('--dry-run reports without writing anything', async () => {
    const podcastId = await makePodcast();
    const episodeOld = await makeEpisode(podcastId, 'ep-old');
    const episodeNew = await makeEpisode(podcastId, 'ep-new');
    const canonical = await seedImageSet({
      externalId: 'ep-old',
      sourceUrlHash: 'url-hash-shared',
      sourceContentHash: 'content-hash-shared',
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const duplicate = await seedImageSet({
      externalId: 'ep-new',
      sourceUrlHash: 'url-hash-shared',
      sourceContentHash: 'content-hash-shared',
      createdAt: new Date('2025-06-01T00:00:00Z'),
    });
    await getDb().update(episodes).set({ imageId: canonical.large }).where(eq(episodes.id, episodeOld));
    await getDb().update(episodes).set({ imageId: duplicate.large }).where(eq(episodes.id, episodeNew));

    const stats = await consolidateDuplicateCatalogImages({ dryRun: true });

    expect(stats.rowsDeleted).toBe(6);
    expect(await countImageAssetRows()).toBe(12);
    expect(await readEpisodeImageId(episodeNew)).toBe(duplicate.large ?? null);
    expect(deletedKeyBatches).toEqual([]);
  });

  it('running twice is a no-op the second time', async () => {
    const podcastId = await makePodcast();
    const episodeOld = await makeEpisode(podcastId, 'ep-old');
    const episodeNew = await makeEpisode(podcastId, 'ep-new');
    const canonical = await seedImageSet({
      externalId: 'ep-old',
      sourceUrlHash: 'url-hash-shared',
      sourceContentHash: 'content-hash-shared',
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const duplicate = await seedImageSet({
      externalId: 'ep-new',
      sourceUrlHash: 'url-hash-shared',
      sourceContentHash: 'content-hash-shared',
      createdAt: new Date('2025-06-01T00:00:00Z'),
    });
    await getDb().update(episodes).set({ imageId: canonical.large }).where(eq(episodes.id, episodeOld));
    await getDb().update(episodes).set({ imageId: duplicate.large }).where(eq(episodes.id, episodeNew));

    await consolidateDuplicateCatalogImages();
    const second = await consolidateDuplicateCatalogImages();

    expect(second.hashGroupsProcessed).toBe(0);
    expect(second.rowsDeleted).toBe(0);
  });
});
