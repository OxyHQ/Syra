import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';
import { findExistingCatalogImageSet } from './imageAssetService';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const SIZES = ['small', 'medium', 'large', 'xlarge', 'xxlarge', 'original'] as const;

/** One complete six-row mirrored set, exactly as `createImageSizes` stamps one. */
async function seedCompleteSet(input: {
  sourceUrlHash: string;
  sourceContentHash: string;
  primaryColor?: string;
  secondaryColor?: string;
}): Promise<void> {
  for (const size of SIZES) {
    await getDb()
      .insert(imageAssets)
      .values({
        s3Key: `images/${input.sourceContentHash}/${size}`,
        filename: `rss-episode-test-${size}`,
        contentType: size === 'original' ? 'image/jpeg' : 'image/webp',
        byteSize: 1000,
        width: 100,
        height: 100,
        ownerType: 'episode',
        primaryColor: input.primaryColor,
        secondaryColor: input.secondaryColor,
        catalogProvider: 'rss',
        catalogEntityType: 'episode',
        catalogExternalId: 'seed-episode',
        catalogSize: size,
        catalogSourceUrlHash: input.sourceUrlHash,
        catalogSourceContentHash: input.sourceContentHash,
      });
  }
}

describe('findExistingCatalogImageSet', () => {
  it('finds a complete prior set by source URL hash', async () => {
    await seedCompleteSet({
      sourceUrlHash: 'url-hash-1',
      sourceContentHash: 'content-hash-1',
      primaryColor: '#112233',
      secondaryColor: '#445566',
    });

    const found = await findExistingCatalogImageSet('sourceUrlHash', 'url-hash-1');

    expect(found).toBeDefined();
    expect(found?.sourceUrlHash).toBe('url-hash-1');
    expect(found?.sourceContentHash).toBe('content-hash-1');
    expect(found?.primaryColor).toBe('#112233');
    expect(found?.secondaryColor).toBe('#445566');
    for (const size of SIZES) {
      expect(found?.imageSizes[size]?.id).toBeTruthy();
      expect(found?.imageSizes[size]?.url).toBe(`/api/images/${found?.imageSizes[size]?.id}`);
    }
    expect(found?.imageId).toBe(found?.imageSizes.large?.id);
  });

  it('finds a complete prior set by source content hash — a different URL, the same bytes', async () => {
    await seedCompleteSet({ sourceUrlHash: 'url-hash-2', sourceContentHash: 'content-hash-2' });

    const found = await findExistingCatalogImageSet('sourceContentHash', 'content-hash-2');

    expect(found).toBeDefined();
    expect(found?.sourceUrlHash).toBe('url-hash-2');
  });

  it('returns undefined for a hash nothing has ever mirrored', async () => {
    const found = await findExistingCatalogImageSet('sourceUrlHash', 'no-such-hash');
    expect(found).toBeUndefined();
  });

  it('refuses an INCOMPLETE set rather than ship a CatalogImageSizes missing keys', async () => {
    // Only three of six sizes stored — e.g. a mirror interrupted mid-upload.
    for (const size of ['small', 'medium', 'large'] as const) {
      await getDb()
        .insert(imageAssets)
        .values({
          s3Key: `images/partial/${size}`,
          filename: `rss-episode-partial-${size}`,
          contentType: 'image/webp',
          byteSize: 1000,
          width: 100,
          height: 100,
          ownerType: 'episode',
          catalogSize: size,
          catalogSourceUrlHash: 'partial-hash',
          catalogSourceContentHash: 'partial-content-hash',
        });
    }

    const found = await findExistingCatalogImageSet('sourceUrlHash', 'partial-hash');
    expect(found).toBeUndefined();
  });

  it('resolves to the OLDEST complete set when a hash matches rows from more than one', async () => {
    await seedCompleteSet({ sourceUrlHash: 'url-hash-dup', sourceContentHash: 'content-hash-old' });
    // A second, later mirror of the identical URL (created before this dedup
    // existed) — the lookup must not non-deterministically pick either.
    await seedCompleteSet({ sourceUrlHash: 'url-hash-dup', sourceContentHash: 'content-hash-new' });

    const found = await findExistingCatalogImageSet('sourceUrlHash', 'url-hash-dup');

    expect(found?.sourceContentHash).toBe('content-hash-old');
  });
});
