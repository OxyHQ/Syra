import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../../test/fakeOxyFiles';
import { getDb } from '../../db/postgres';
import { imageAssets } from '../../db/schema/catalog';
import { adoptCoverFile } from './adoptedCovers';

/**
 * `imageFileId`: a show cover that is already somebody's Oxy file — Alia's, for
 * the shows it draws. Syra uses it without copying it, and only when the file is
 * the caller's own or a trusted application's.
 */

const ALIA = 'app-alia';
beforeAll(connectDb);
let oxy: FakeOxyFiles;
const saved = process.env.SYRA_COVER_APPLICATION_IDS;
beforeEach(() => {
  oxy = installFakeOxyFiles();
  process.env.SYRA_COVER_APPLICATION_IDS = ` ${ALIA} , `;
});
afterEach(async () => {
  resetOxyFiles();
  if (saved === undefined) delete process.env.SYRA_COVER_APPLICATION_IDS;
  else process.env.SYRA_COVER_APPLICATION_IDS = saved;
  await clearDb();
});
afterAll(disconnectDb);

const cover = (color = '#aa22cc') =>
  sharp({ create: { width: 1024, height: 1024, channels: 3, background: color } })
    .png()
    .toBuffer();

const CALLER = { oxyUserId: 'creator-1', podcastId: 'podcast-1' };

describe('adoptCoverFile', () => {
  it("adopts Alia's public cover: references it as the show and builds the size set", async () => {
    const file = oxy.seedFile({ bytes: await cover(), ownerApplicationId: ALIA });
    const adopted = await adoptCoverFile(file.id, CALLER);

    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(oxy.hasReference(file.id, 'podcast', 'podcast-1')).toBe(true);
    expect(adopted.imageSizes.large).toMatchObject({ fileId: file.id, variant: 'w640' });
    expect(adopted.primaryColor).toBeDefined();
    const rows = await getDb().select().from(imageAssets).where(eq(imageAssets.oxyFileId, file.id));
    expect(rows).toHaveLength(6);
    // Alia's file stays Alia's: no copy was made.
    expect(oxy.files.size).toBe(1);
    expect(rows.every((row) => row.uploadedBy === null)).toBe(true);
  });

  it("adopts the caller's own file and records them as its uploader", async () => {
    const file = oxy.seedFile({ bytes: await cover(), ownerUserId: 'creator-1' });
    const adopted = await adoptCoverFile(file.id, CALLER);
    expect(adopted.ok).toBe(true);
    const [row] = await getDb()
      .select()
      .from(imageAssets)
      .where(eq(imageAssets.oxyFileId, file.id));
    expect(row?.uploadedBy).toBe('creator-1');
  });

  it('reuses the set when the file is adopted again', async () => {
    const file = oxy.seedFile({ bytes: await cover(), ownerApplicationId: ALIA });
    const first = await adoptCoverFile(file.id, CALLER);
    const second = await adoptCoverFile(file.id, { ...CALLER, podcastId: 'podcast-2' });
    expect(first.ok && second.ok && first.imageId === second.imageId).toBe(true);
    expect(await getDb().select().from(imageAssets)).toHaveLength(6);
  });

  it("refuses someone else's file, an untrusted application's, and anything not an active image", async () => {
    const strangers = oxy.seedFile({ bytes: await cover('#111111'), ownerUserId: 'someone-else' });
    const untrusted = oxy.seedFile({
      bytes: await cover('#222222'),
      ownerApplicationId: 'app-other',
    });
    const video = oxy.seedFile({
      bytes: Buffer.from('v'),
      mime: 'video/mp4',
      ownerUserId: 'creator-1',
    });
    const trashed = oxy.seedFile({ bytes: await cover('#333333'), ownerUserId: 'creator-1' });
    trashed.status = 'trash';

    expect(await adoptCoverFile(strangers.id, CALLER)).toEqual({ ok: false, reason: 'not_yours' });
    expect(await adoptCoverFile(untrusted.id, CALLER)).toEqual({ ok: false, reason: 'not_yours' });
    expect(await adoptCoverFile(video.id, CALLER)).toEqual({ ok: false, reason: 'not_an_image' });
    expect(await adoptCoverFile(trashed.id, CALLER)).toEqual({ ok: false, reason: 'unknown_file' });
    expect(await adoptCoverFile('no-such-file', CALLER)).toEqual({
      ok: false,
      reason: 'unknown_file',
    });
    expect(oxy.refs.size).toBe(0);
  });

  it('refuses a file Syra may not reference — a private one — before writing a row', async () => {
    const file = oxy.seedFile({
      bytes: await cover(),
      ownerApplicationId: ALIA,
      visibility: 'private',
    });
    expect(await adoptCoverFile(file.id, CALLER)).toEqual({
      ok: false,
      reason: 'not_referenceable',
    });
    expect(await getDb().select().from(imageAssets)).toHaveLength(0);
  });

  it('trusts no application when the allow-list is empty', async () => {
    process.env.SYRA_COVER_APPLICATION_IDS = '';
    const file = oxy.seedFile({ bytes: await cover(), ownerApplicationId: ALIA });
    expect(await adoptCoverFile(file.id, CALLER)).toEqual({ ok: false, reason: 'not_yours' });
  });
});
