import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import sharp from 'sharp';
import { count, eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../../test/fakeOxyFiles';
import { getDb } from '../../db/postgres';
import { imageAssets } from '../../db/schema/catalog';
import { importableSourceUrl, mirrorCatalogImage } from './catalogImageAssets';

/**
 * Catalogue artwork is imported BY OXY (ADR 0041 D7) as Syra's own file, and
 * deduplicated by Oxy: the same URL, or the same bytes, is the same file — so the
 * same six rows. What used to take a URL-hash lookup, a content-hash lookup and a
 * merge script is asserted here as "no new rows".
 */

beforeAll(connectDb);
let oxy: FakeOxyFiles;
beforeEach(() => {
  oxy = installFakeOxyFiles();
});
afterEach(async () => {
  resetOxyFiles();
  await clearDb();
});
afterAll(disconnectDb);

async function serveImage(url: string, color = '#3366cc'): Promise<void> {
  const bytes = await sharp({ create: { width: 900, height: 900, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
  oxy.remote.set(url, { bytes, mime: 'image/jpeg' });
}

async function rowCount(): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(imageAssets);
  return row?.n ?? 0;
}

const CONTEXT = { provider: 'rss', entityType: 'episode', externalId: 'ep-1' } as const;

describe('importableSourceUrl', () => {
  it('asks for https, because Oxy imports nothing else', () => {
    expect(importableSourceUrl('http://img.example/a.jpg')).toBe('https://img.example/a.jpg');
    expect(importableSourceUrl('https://img.example/a.jpg?x=1')).toBe(
      'https://img.example/a.jpg?x=1',
    );
  });
});

describe('mirrorCatalogImage', () => {
  it("imports the image as Syra's public file and builds the six-row set", async () => {
    await serveImage('https://img.example/a.jpg');
    const asset = await mirrorCatalogImage([{ url: 'https://img.example/a.jpg' }], CONTEXT);

    expect(asset).toBeDefined();
    const [file] = [...oxy.files.values()];
    expect(file?.ownerApplicationId).toBe(oxy.applicationId);
    expect(file?.visibility).toBe('public');
    expect(asset?.imageSizes.large).toMatchObject({ fileId: file?.id, variant: 'w640' });
    expect(asset?.sourceContentHash).toBe(file?.sha256 as string);
    expect(asset?.primaryColor).toBeDefined();
    expect(await rowCount()).toBe(6);
    const [row] = await getDb()
      .select()
      .from(imageAssets)
      .where(eq(imageAssets.id, asset?.imageId as string));
    expect(row).toMatchObject({
      catalogProvider: 'rss',
      catalogEntityType: 'episode',
      s3Key: null,
    });
  });

  it('reuses the set for the same URL and for the same bytes at another URL', async () => {
    await serveImage('https://img.example/a.jpg');
    const first = await mirrorCatalogImage([{ url: 'https://img.example/a.jpg' }], CONTEXT);
    const again = await mirrorCatalogImage([{ url: 'https://img.example/a.jpg' }], {
      ...CONTEXT,
      externalId: 'ep-2',
    });
    oxy.remote.set('https://cdn.example/same.jpg', oxy.remote.get('https://img.example/a.jpg')!);
    const sameBytes = await mirrorCatalogImage([{ url: 'https://cdn.example/same.jpg' }], {
      ...CONTEXT,
      externalId: 'ep-3',
    });

    expect(again?.imageId).toBe(first?.imageId as string);
    expect(sameBytes?.imageId).toBe(first?.imageId as string);
    expect(oxy.files.size).toBe(1);
    expect(await rowCount()).toBe(6);
  });

  it("keeps an entity's own set when its source is unchanged, and revalidates it", async () => {
    await serveImage('https://img.example/a.jpg');
    const first = await mirrorCatalogImage([{ url: 'https://img.example/a.jpg' }], CONTEXT);
    const recrawl = await mirrorCatalogImage([{ url: 'https://img.example/a.jpg' }], {
      ...CONTEXT,
      existingImageId: first?.imageId,
      existingImageSizes: first?.imageSizes,
    });

    expect(recrawl?.imageId).toBe(first?.imageId as string);
    // No colours on the unchanged path: the caller keeps the ones it has.
    expect(recrawl?.primaryColor).toBeUndefined();
    const lastImport = oxy.calls.filter((call) => call.method === 'importAppFile').at(-1);
    expect(lastImport?.args[1]).toMatchObject({ revalidate: true });
  });

  it('upgrades an http candidate to https and falls through a failing one', async () => {
    await serveImage('https://img.example/b.jpg');
    const asset = await mirrorCatalogImage(
      [{ url: 'https://broken.example/missing.jpg' }, { url: 'http://img.example/b.jpg' }],
      CONTEXT,
    );

    expect(asset).toBeDefined();
    const imported = oxy.calls
      .filter((call) => call.method === 'importAppFile')
      .map((call) => call.args[0]);
    expect(imported).toEqual(['https://broken.example/missing.jpg', 'https://img.example/b.jpg']);
  });

  it('answers undefined when no candidate imports', async () => {
    expect(
      await mirrorCatalogImage([{ url: 'https://nowhere.example/x.jpg' }], CONTEXT),
    ).toBeUndefined();
    expect(await rowCount()).toBe(0);
  });
});
