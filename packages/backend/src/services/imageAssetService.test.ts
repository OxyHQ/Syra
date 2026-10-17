import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Readable } from 'stream';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../test/fakeOxyFiles';
import { getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';
import { pendingLegacyReads } from './oxyFiles/legacyReads';
import {
  resolveImageAsset,
  setLegacyImageReaderForTests,
  storeImageAsset,
} from './imageAssetService';

/**
 * Writes go to Oxy Files only; reads take the Oxy file first and the legacy
 * bucket object only when there is none — and count that fallback, because the
 * bucket's retirement waits for the count to reach zero.
 */

beforeAll(connectDb);
let oxy: FakeOxyFiles;
const legacyKeysRead: string[] = [];
beforeEach(() => {
  oxy = installFakeOxyFiles();
  legacyKeysRead.length = 0;
  setLegacyImageReaderForTests(async (key) => {
    legacyKeysRead.push(key);
    return {
      stream: Readable.from([Buffer.from('legacy')]),
      contentLength: 6,
      contentType: 'image/jpeg',
    };
  });
});
afterEach(async () => {
  resetOxyFiles();
  setLegacyImageReaderForTests(null);
  await clearDb();
});
afterAll(disconnectDb);

const png = () =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: '#118844' } })
    .png()
    .toBuffer();

describe('storeImageAsset', () => {
  it("stores a person's upload in their own Oxy account", async () => {
    oxy.localUsers.add('person-1');
    const stored = await storeImageAsset({
      buffer: await png(),
      filename: 'cover.png',
      contentType: 'image/png',
      ownerType: 'upload',
      uploadedBy: 'person-1',
    });

    expect(oxy.files.get(stored.fileId)?.ownerUserId).toBe('person-1');
    const [row] = await getDb().select().from(imageAssets).where(eq(imageAssets.id, stored.id));
    expect(row).toMatchObject({
      oxyFileId: stored.fileId,
      oxyVariant: null,
      s3Key: null,
      uploadedBy: 'person-1',
      width: 64,
      height: 48,
    });
    expect(stored.pixels.primaryColor).toBeDefined();
  });

  it("stores an image nobody uploaded as Syra's own file", async () => {
    const stored = await storeImageAsset({
      buffer: await png(),
      filename: 'x.png',
      contentType: 'image/png',
      ownerType: 'upload',
    });
    expect(oxy.files.get(stored.fileId)?.ownerApplicationId).toBe(oxy.applicationId);
  });

  it('fails loudly, and writes no row, when Oxy refuses the upload', async () => {
    await expect(
      storeImageAsset({
        buffer: await png(),
        filename: 'x.png',
        contentType: 'image/png',
        ownerType: 'upload',
        uploadedBy: 'not-a-local-user',
      }),
    ).rejects.toThrow();
    expect(await getDb().select().from(imageAssets)).toHaveLength(0);
  });
});

describe('resolveImageAsset — Oxy first, the bucket only as a fallback', () => {
  async function row(values: Partial<typeof imageAssets.$inferInsert>): Promise<string> {
    const [inserted] = await getDb()
      .insert(imageAssets)
      .values({
        filename: 'f',
        contentType: 'image/jpeg',
        byteSize: 1,
        ownerType: 'upload',
        ...values,
      })
      .returning({ id: imageAssets.id });
    return inserted!.id;
  }

  it("redirects to the Oxy file's rendition when the row has one, even with a bucket copy", async () => {
    const id = await row({ oxyFileId: 'file-1', oxyVariant: 'w320', s3Key: 'images/a/b' });
    expect(await resolveImageAsset(id)).toEqual({
      kind: 'oxy',
      url: 'https://cloud.test/file-1?variant=w320',
    });
    expect(legacyKeysRead).toEqual([]);
  });

  it('streams a legacy row from the bucket and counts it', async () => {
    const before = pendingLegacyReads().get('image_asset') ?? 0;
    const id = await row({ s3Key: 'images/legacy/cover.jpg' });
    const resolved = await resolveImageAsset(id);
    expect(resolved?.kind).toBe('legacy');
    expect(legacyKeysRead).toEqual(['images/legacy/cover.jpg']);
    expect(pendingLegacyReads().get('image_asset')).toBe(before + 1);
  });

  it('never falls back to the bucket for an image Oxy will not serve', async () => {
    const blocked = await row({
      oxyFileId: 'file-2',
      s3Key: 'images/x/y',
      servingStatus: 'blocked',
    });
    const missing = await row({ s3Key: 'images/gone', servingStatus: 'missing' });
    expect(await resolveImageAsset(blocked)).toEqual({ kind: 'unavailable' });
    expect(await resolveImageAsset(missing)).toEqual({ kind: 'unavailable' });
    expect(legacyKeysRead).toEqual([]);
  });

  it('answers null for an id that names no row', async () => {
    expect(await resolveImageAsset('no-such-id')).toBeNull();
  });
});
