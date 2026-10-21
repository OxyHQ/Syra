import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../test/fakeOxyFiles';
import { getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';
import { resolveImageAsset, storeImageAsset } from './imageAssetService';

/** Every image is an Oxy file: written there, and served by redirecting to it. */

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

describe('resolveImageAsset', () => {
  async function row(
    values: Partial<typeof imageAssets.$inferInsert> & { oxyFileId: string },
  ): Promise<string> {
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

  it("redirects to the Oxy file's rendition", async () => {
    const id = await row({ oxyFileId: 'file-1', oxyVariant: 'w320' });
    expect(await resolveImageAsset(id)).toEqual({
      kind: 'oxy',
      url: 'https://cloud.test/file-1?variant=w320',
    });
  });

  it('answers unavailable for an image Oxy will not serve', async () => {
    const blocked = await row({ oxyFileId: 'file-2', servingStatus: 'blocked' });
    const trashed = await row({ oxyFileId: 'file-3', servingStatus: 'unavailable' });
    expect(await resolveImageAsset(blocked)).toEqual({ kind: 'unavailable' });
    expect(await resolveImageAsset(trashed)).toEqual({ kind: 'unavailable' });
  });

  it('answers null for an id that names no row', async () => {
    expect(await resolveImageAsset('no-such-id')).toBeNull();
  });
});
