import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../../test/fakeOxyFiles';
import { getDb } from '../../db/postgres';
import { imageAssets } from '../../db/schema/catalog';
import {
  CATALOG_SIZE_VARIANTS,
  findOxyImageSet,
  insertOxyImageSet,
  measureOxyFile,
  uploadAppImage,
  uploadUserImage,
  variantDimensions,
} from './images';

/**
 * A catalogue image is ONE Oxy file and six rows naming it — the shape every DTO,
 * `/api/images/:id` and the reference triggers rely on.
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

function png(width: number, height: number, color = '#cc3300'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

describe('variantDimensions', () => {
  it('fits inside the box and never enlarges', () => {
    expect(variantDimensions(3000, 3000, 'thumb')).toEqual({ width: 256, height: 256 });
    expect(variantDimensions(3000, 1500, 'w640')).toEqual({ width: 640, height: 320 });
    expect(variantDimensions(400, 300, 'w1280')).toEqual({ width: 400, height: 300 });
    expect(variantDimensions(1000, 2000, 'thumb')).toEqual({ width: 128, height: 256 });
    expect(variantDimensions(1000, 2000, null)).toEqual({ width: 1000, height: 2000 });
  });

  it('serves every size from a rendition at least as large as the square it replaced', () => {
    const replaced = { small: 160, medium: 320, large: 640, xlarge: 960, xxlarge: 1280 };
    for (const [size, px] of Object.entries(replaced)) {
      const variant = CATALOG_SIZE_VARIANTS[size as keyof typeof replaced];
      expect(variant).not.toBeNull();
      expect(variantDimensions(4000, 4000, variant).width).toBeGreaterThanOrEqual(px);
    }
    expect(CATALOG_SIZE_VARIANTS.original).toBeNull();
  });
});

describe('the six-row set', () => {
  it('writes one row per size, all naming the one file, and finds them again by file', async () => {
    const file = await uploadAppImage(await png(1200, 1200), 'image/png', 'cover.png');
    const set = await insertOxyImageSet({
      file,
      pixels: { width: 1200, height: 1200, primaryColor: '#cc3300' },
      ownerType: 'album',
      filename: 'cc-album-x',
      catalog: { provider: 'cc', entityType: 'album', externalId: 'x', sourceUrlHash: 'h' },
    });

    const rows = await getDb().select().from(imageAssets).where(eq(imageAssets.oxyFileId, file.id));
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.oxyVariant))).toEqual(
      new Set(['thumb', 'w320', 'w640', 'w1280', null]),
    );
    expect(set.imageSizes.large).toMatchObject({ fileId: file.id, variant: 'w640', width: 640 });
    expect(set.imageSizes.original).toMatchObject({ fileId: file.id, width: 1200 });
    expect(set.imageSizes.original?.variant).toBeUndefined();
    expect(set.imageId).toBe(set.imageSizes.large?.id as string);
    expect(set.sourceContentHash).toBe(file.sha256);

    const found = await findOxyImageSet(file.id);
    expect(found?.imageId).toBe(set.imageId);
    expect(found?.imageSizes).toEqual(set.imageSizes);
    expect(found?.primaryColor).toBe('#cc3300');
  });

  it('finds nothing for a file with no complete set', async () => {
    expect(await findOxyImageSet('no-such-file')).toBeUndefined();
  });
});

describe('ownership', () => {
  it("stores Syra's artwork as the application's file and a person's upload in their account", async () => {
    oxy.localUsers.add('person-1');
    const bytes = await png(10, 10);
    const app = await uploadAppImage(bytes, 'image/png', 'a.png');
    const person = await uploadUserImage('person-1', bytes, 'image/png', 'a.png', {
      requesterToken: 'verified-session',
      accountId: 'person-1',
    });

    expect(oxy.files.get(app.id)?.ownerApplicationId).toBe(oxy.applicationId);
    expect(oxy.files.get(person.id)?.ownerUserId).toBe('person-1');
    // Same bytes, two owners: two files (rows are per owner), one SHA-256.
    expect(app.id).not.toBe(person.id);
    expect(app.sha256).toBe(person.sha256);
  });

  it('measures a file it never held from Oxy', async () => {
    const file = oxy.seedFile({
      bytes: await png(300, 200, '#0044ff'),
      ownerApplicationId: 'other',
    });
    const pixels = await measureOxyFile(file.id);
    expect(pixels).toMatchObject({ width: 300, height: 200 });
    expect(pixels.primaryColor).toBeDefined();
  });
});
