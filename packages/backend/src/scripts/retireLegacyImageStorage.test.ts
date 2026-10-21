import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';
import { LEGACY_IMAGE_READ_KINDS } from '../db/schema/oxyFiles';
import { LEGACY_IMAGE_PREFIXES } from '../config/s3.config';
import {
  checkRetirementGate,
  retireLegacyImageStorage,
  SOAK_DAYS,
  SOAK_WAIVER,
  soakDaysAt,
} from './retireLegacyImageStorage';

/**
 * The bucket's image prefixes are deleted only when the code says nobody can
 * need them: no legacy read for a full soak — counted every day — and nothing
 * still stored only there.
 */

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const NOW = new Date('2026-11-30T12:00:00Z');

async function countedDays(
  days: number,
  readsOnDay?: { daysAgo: number; reads: number },
  now: Date = NOW,
) {
  for (let back = 1; back <= days; back += 1) {
    const day = new Date(now.getTime() - back * 86_400_000).toISOString().slice(0, 10);
    for (const kind of LEGACY_IMAGE_READ_KINDS) {
      const reads = readsOnDay?.daysAgo === back && kind === 'image_asset' ? readsOnDay.reads : 0;
      await getDb().execute(sql`
        insert into oxy_files_legacy_reads (day, kind, reads) values (${day}::date, ${kind}, ${reads})
      `);
    }
  }
}

describe('checkRetirementGate', () => {
  it('fails while the soak is shorter than its length, even with zero reads', async () => {
    await countedDays(SOAK_DAYS - 1);
    const gate = await checkRetirementGate(NOW);
    expect(gate.passed).toBe(false);
    expect(gate.checks.legacyReads).toMatchObject({
      reads: 0,
      daysCounted: SOAK_DAYS - 1,
      passed: false,
    });
  });

  it('fails on a single legacy read inside the soak', async () => {
    await countedDays(SOAK_DAYS, { daysAgo: 3, reads: 1 });
    expect((await checkRetirementGate(NOW)).checks.legacyReads).toMatchObject({
      reads: 1,
      passed: false,
    });
  });

  it('fails while a referenced image is still only in the bucket', async () => {
    await countedDays(SOAK_DAYS);
    await getDb().insert(imageAssets).values({
      id: 'img',
      s3Key: 'images/img/x',
      filename: 'f',
      contentType: 'image/png',
      byteSize: 1,
      ownerType: 'upload',
    });
    await getDb().execute(sql`
      insert into playlists (id, name, owner_oxy_user_id, owner_username, cover_art_id)
      values ('p', 'P', 'u', 'u', 'img')
    `);
    const gate = await checkRetirementGate(NOW);
    expect(gate.checks.bucketOnlyReferencedImages).toEqual({ rows: 1, passed: false });
    expect(gate.passed).toBe(false);
  });

  it('fails while a house image is still a bucket URL, but not for an external one', async () => {
    await countedDays(SOAK_DAYS);
    await getDb().execute(sql`
      insert into houses (id, name, created_by, avatar, cover_image)
      values ('h', 'H', 'u', 'https://syra-audio.s3.us-west-2.amazonaws.com/agora/houses/h/avatar.webp',
        'https://elsewhere.example/c.jpg')
    `);
    expect((await checkRetirementGate(NOW)).checks.bucketSpaceImages).toEqual({
      rows: 1,
      passed: false,
    });
  });
});

describe('the dated soak waiver', () => {
  const INSIDE = new Date(`${SOAK_WAIVER.from}T12:00:00Z`);

  it('applies only inside its window', () => {
    expect(soakDaysAt(new Date(`${SOAK_WAIVER.from}T00:00:00Z`))).toBe(SOAK_WAIVER.days);
    expect(soakDaysAt(new Date(`${SOAK_WAIVER.until}T00:00:00Z`))).toBe(SOAK_DAYS);
    expect(soakDaysAt(new Date('2026-10-20T23:59:59Z'))).toBe(SOAK_DAYS);
    expect(soakDaysAt(NOW)).toBe(SOAK_DAYS);
  });

  it('inside the window, passes on the waived soak and still fails on a read in it', async () => {
    await countedDays(SOAK_WAIVER.days, undefined, INSIDE);
    expect((await checkRetirementGate(INSIDE)).checks.legacyReads).toEqual({
      days: SOAK_WAIVER.days,
      daysCounted: SOAK_WAIVER.days,
      reads: 0,
      passed: true,
    });
    await clearDb();
    await countedDays(SOAK_WAIVER.days, { daysAgo: 2, reads: 1 }, INSIDE);
    expect((await checkRetirementGate(INSIDE)).checks.legacyReads.passed).toBe(false);
  });

  it('inside the window, still fails on an uncounted day', async () => {
    await countedDays(SOAK_WAIVER.days - 1, undefined, INSIDE);
    expect((await checkRetirementGate(INSIDE)).checks.legacyReads.passed).toBe(false);
  });
});

describe('retireLegacyImageStorage', () => {
  async function seedRetirable() {
    await countedDays(SOAK_DAYS);
    await getDb()
      .insert(imageAssets)
      .values([
        {
          id: 'moved',
          s3Key: 'images/moved/x',
          oxyFileId: 'F',
          filename: 'f',
          contentType: 'image/png',
          byteSize: 1,
          ownerType: 'upload',
        },
        {
          id: 'garbage',
          s3Key: 'images/garbage/x',
          filename: 'f',
          contentType: 'image/png',
          byteSize: 1,
          ownerType: 'upload',
        },
      ]);
  }

  it('changes nothing without --apply, even on a passing gate', async () => {
    await seedRetirable();
    const deleted: string[] = [];
    const result = await retireLegacyImageStorage({
      now: NOW,
      deletePrefix: async (prefix) => (deleted.push(prefix), 0),
    });
    expect(result.gate.passed).toBe(true);
    expect(result.applied).toBe(false);
    expect(deleted).toEqual([]);
  });

  it('on a passing gate, drops the bucket keys, the unreferenced garbage and the prefixes', async () => {
    await seedRetirable();
    const deleted: string[] = [];
    const result = await retireLegacyImageStorage({
      apply: true,
      now: NOW,
      deletePrefix: async (prefix) => (deleted.push(prefix), 3),
    });

    expect(result).toMatchObject({ applied: true, s3KeysCleared: 1, unreferencedRowsDeleted: 1 });
    expect(deleted).toEqual([...LEGACY_IMAGE_PREFIXES]);
    expect(result.objectsDeleted).toBe(3 * LEGACY_IMAGE_PREFIXES.length);
    const [moved] = await getDb().select().from(imageAssets).where(eq(imageAssets.id, 'moved'));
    expect(moved?.s3Key).toBeNull();
    expect(await getDb().select().from(imageAssets).where(eq(imageAssets.id, 'garbage'))).toEqual(
      [],
    );
  });

  it('deletes nothing on a failing gate, even with --apply', async () => {
    await countedDays(SOAK_DAYS, { daysAgo: 1, reads: 2 });
    const deleted: string[] = [];
    const result = await retireLegacyImageStorage({
      apply: true,
      now: NOW,
      deletePrefix: async (prefix) => (deleted.push(prefix), 0),
    });
    expect(result.applied).toBe(false);
    expect(deleted).toEqual([]);
  });
});
