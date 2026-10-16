import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import sharp from 'sharp';
import { eq, sql } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../test/fakeOxyFiles';
import { getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';
import { podcasts } from '../db/schema/podcasts';
import { migrateAliaCovers, type AliaCoverReportLine } from './migrateAliaCovers';

/**
 * Alia's covers go back to Alia: Syra finds Alia's copy by the SHA-256 of its
 * own legacy bytes and accepts it only when Oxy says Alia owns it.
 */

const ALIA = 'app-alia';
beforeAll(connectDb);
let oxy: FakeOxyFiles;
const bucket = new Map<string, Buffer>();
const readObject = async (key: string) => {
  const bytes = bucket.get(key);
  return bytes ? { bytes } : null;
};
const saved = process.env.SYRA_COVER_APPLICATION_IDS;
beforeEach(() => {
  oxy = installFakeOxyFiles();
  bucket.clear();
  process.env.SYRA_COVER_APPLICATION_IDS = ALIA;
});
afterEach(async () => {
  resetOxyFiles();
  if (saved === undefined) delete process.env.SYRA_COVER_APPLICATION_IDS;
  else process.env.SYRA_COVER_APPLICATION_IDS = saved;
  await clearDb();
});
afterAll(disconnectDb);

const cover = (color: string) =>
  sharp({ create: { width: 512, height: 512, channels: 3, background: color } })
    .png()
    .toBuffer();

async function aliaShow(id: string, bytes: Buffer): Promise<void> {
  bucket.set(`images/${id}-cover/cover.png`, bytes);
  await getDb()
    .insert(imageAssets)
    .values({
      id: `${id}-cover`,
      s3Key: `images/${id}-cover/cover.png`,
      filename: 'cover.png',
      contentType: 'image/png',
      byteSize: bytes.length,
      ownerType: 'upload',
      uploadedBy: 'show-owner',
    });
  await getDb().execute(sql`
    insert into podcasts (id, title, source, owner_oxy_user_id, image_id)
    values (${id}, 'Show', 'syra', 'show-owner', ${`${id}-cover`})
  `);
  await getDb().execute(sql`
    insert into podcast_sources (id, podcast_id, position, provider, external_id, imported_at)
    values (${`src-${id}`}, ${id}, 0, 'alia', ${`series-${id}`}, '2026-10-16')
  `);
}

async function run(apply: boolean) {
  const lines: AliaCoverReportLine[] = [];
  const stats = await migrateAliaCovers({ apply, readObject, report: (line) => lines.push(line) });
  return { stats, lines };
}

describe('migrateAliaCovers', () => {
  it("points the show at Alia's copy of the same bytes, references it, and never copies it", async () => {
    const bytes = await cover('#aa3300');
    await aliaShow('show-1', bytes);
    const alias = oxy.seedFile({ bytes, ownerApplicationId: ALIA });

    expect((await run(false)).lines[0]).toMatchObject({ outcome: 'planned', fileId: alias.id });
    const { lines } = await run(true);

    expect(lines[0]).toMatchObject({
      outcome: 'repointed',
      fileId: alias.id,
      sha256: alias.sha256,
    });
    const [show] = await getDb().select().from(podcasts).where(eq(podcasts.id, 'show-1'));
    const [large] = await getDb()
      .select()
      .from(imageAssets)
      .where(eq(imageAssets.id, show?.imageSizesLargeId as string));
    expect(large?.oxyFileId).toBe(alias.id);
    expect(show?.imageId).toBe(show?.imageSizesLargeId as string);
    expect(oxy.hasReference(alias.id, 'podcast', 'show-1')).toBe(true);
    expect(oxy.files.size).toBe(1);
    // Done: the next run has nothing to hand over.
    expect((await run(true)).lines).toEqual([]);
  });

  it('waits for Alia when no file holds the bytes yet', async () => {
    await aliaShow('show-1', await cover('#aa3300'));
    expect((await run(true)).lines[0]).toMatchObject({ outcome: 'awaiting_alia' });
  });

  it('refuses the same bytes held by anyone who is not a trusted application', async () => {
    const bytes = await cover('#aa3300');
    await aliaShow('show-1', bytes);
    oxy.seedFile({ bytes, ownerUserId: 'somebody' });
    const { lines } = await run(true);
    expect(lines[0]).toMatchObject({ outcome: 'not_alia_file' });
    const [show] = await getDb().select().from(podcasts).where(eq(podcasts.id, 'show-1'));
    expect(show?.imageId).toBe('show-1-cover');
  });

  it("leaves a show that is not Alia's alone", async () => {
    const bytes = await cover('#aa3300');
    bucket.set('images/x/cover.png', bytes);
    await getDb().insert(imageAssets).values({
      id: 'x',
      s3Key: 'images/x/cover.png',
      filename: 'cover.png',
      contentType: 'image/png',
      byteSize: 1,
      ownerType: 'upload',
    });
    await getDb().execute(sql`
      insert into podcasts (id, title, source, image_id) values ('show-2', 'S', 'syra', 'x')
    `);
    oxy.seedFile({ bytes, ownerApplicationId: ALIA });
    expect((await run(true)).lines).toEqual([]);
  });
});
