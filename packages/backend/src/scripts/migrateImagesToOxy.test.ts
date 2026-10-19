import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { eq, sql } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../test/fakeOxyFiles';
import { getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';
import { houses } from '../db/schema/rooms';
import { FakeOxyError } from '../test/fakeOxyFiles';
import { OxyWritePacer } from '../services/oxyFiles/writePacer';
import { cdnUrlToKey } from '../utils/spaces';
import { migrateImagesToOxy, type MigrationReportLine } from './migrateImagesToOxy';

/**
 * Copying the legacy bucket into Oxy Files: who ends up owning each image, that
 * a set is copied once as one file, that every copy is verified, that what is
 * not Syra's to copy stays put — and that a second run finds nothing to do.
 */

beforeAll(connectDb);
let oxy: FakeOxyFiles;
/** The legacy bucket, by key. */
const bucket = new Map<string, Buffer>();
const readObject = async (key: string) => {
  const bytes = bucket.get(key);
  return bytes ? { bytes, contentType: 'image/png' } : null;
};
beforeEach(() => {
  oxy = installFakeOxyFiles();
  bucket.clear();
});
afterEach(async () => {
  resetOxyFiles();
  await clearDb();
});
afterAll(disconnectDb);

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const png = (color: string, size = 1000) =>
  sharp({ create: { width: size, height: size, channels: 3, background: color } })
    .png()
    .toBuffer();

const SIZES = ['small', 'medium', 'large', 'xlarge', 'xxlarge', 'original'] as const;

/** A legacy six-size catalogue set; returns its row ids by size. */
async function legacySet(prefix: string, original: Buffer): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const size of SIZES) {
    const id = `${prefix}-${size}`;
    const key = `images/${id}/x`;
    bucket.set(key, size === 'original' ? original : Buffer.from(`${prefix}-${size}`));
    await getDb()
      .insert(imageAssets)
      .values({
        id,
        s3Key: key,
        filename: id,
        contentType: size === 'original' ? 'image/png' : 'image/webp',
        byteSize: 1,
        width: size === 'original' ? 1000 : 160,
        height: size === 'original' ? 1000 : 160,
        ownerType: 'album',
        catalogProvider: 'cc',
        catalogEntityType: 'album',
        catalogExternalId: prefix,
        catalogSize: size,
        catalogSourceContentHash: sha(original),
      });
    ids[size] = id;
  }
  return ids;
}

async function legacySingle(id: string, bytes: Buffer, uploadedBy?: string): Promise<void> {
  bucket.set(`images/${id}/x`, bytes);
  await getDb()
    .insert(imageAssets)
    .values({
      id,
      s3Key: `images/${id}/x`,
      filename: id,
      contentType: 'image/png',
      byteSize: bytes.length,
      ownerType: 'upload',
      ...(uploadedBy ? { uploadedBy } : {}),
    });
}

async function artist(id: string, imageIds: Record<string, string>): Promise<void> {
  await getDb().execute(sql`
    insert into catalog_entities (id, type, name, name_key, source, image_id, image_sizes_large_id, image_sizes_small_id)
    values (${id}, 'artist', ${id}, ${id}, 'upload', ${imageIds.large}, ${imageIds.large}, ${imageIds.small})
  `);
}

async function playlist(id: string, coverId: string): Promise<void> {
  await getDb().execute(sql`
    insert into playlists (id, name, owner_oxy_user_id, owner_username, cover_art_id)
    values (${id}, 'P', 'u', 'u', ${coverId})
  `);
}

const ORIGIN = 'https://api.syra.test';

/**
 * What `GET /api/images/:id` serves Oxy's importer: the bucket object of a row
 * that names no Oxy file yet.
 */
async function serveImagesApi(): Promise<void> {
  oxy.remote.clear();
  const rows = await getDb().select().from(imageAssets);
  for (const row of rows) {
    const bytes = row.s3Key && row.oxyFileId === null ? bucket.get(row.s3Key) : undefined;
    if (bytes) oxy.remote.set(`${ORIGIN}/api/images/${row.id}`, { bytes, mime: row.contentType });
  }
}

/**
 * Waits nothing, and counts what it would have waited. The pacer's clock is
 * virtual and moves only by what it slept: on the wall clock, the millisecond
 * between a 429 and the retry's slot made the recorded wait 41,999, not 42,000.
 */
const waits: number[] = [];
const pacer = () => {
  let clock = 0;
  return new OxyWritePacer({
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
};

async function run(apply: boolean, options: { limit?: number } = {}) {
  await serveImagesApi();
  const lines: MigrationReportLine[] = [];
  const stats = await migrateImagesToOxy({
    apply,
    readObject,
    objectExists: async (key) => bucket.has(key),
    publicOrigin: ORIGIN,
    pacer: pacer(),
    ...options,
    report: (line) => lines.push(line),
  });
  return { stats, lines };
}

describe('migrateImagesToOxy — images', () => {
  it('previews without reading or writing anything', async () => {
    await artist('ce-1', await legacySet('set-1', await png('#123456')));
    const { stats, lines } = await run(false);
    expect(stats.planned).toBe(1);
    expect(lines[0]).toMatchObject({
      kind: 'catalog_set',
      owner: 'application',
      outcome: 'planned',
    });
    expect(oxy.files.size).toBe(0);
    const [row] = await getDb().select().from(imageAssets).where(eq(imageAssets.id, 'set-1-large'));
    expect(row?.oxyFileId).toBeNull();
  });

  it("copies a set's ORIGINAL once, as Syra's file, and repoints every size and duplicate", async () => {
    const original = await png('#123456');
    await artist('ce-1', await legacySet('set-1', original));
    await artist('ce-2', await legacySet('set-2', original)); // same bytes, mirrored twice

    const { stats, lines } = await run(true);

    expect(stats.copied).toBe(1);
    expect(oxy.files.size).toBe(1);
    const [file] = [...oxy.files.values()];
    expect(file?.ownerApplicationId).toBe(oxy.applicationId);
    expect(file?.sha256).toBe(sha(original));
    expect(lines.find((line) => line.outcome === 'copied')).toMatchObject({
      sha256: sha(original),
      fileId: file?.id,
    });
    const rows = await getDb().select().from(imageAssets);
    expect(rows.every((row) => row.oxyFileId === file?.id)).toBe(true);
    const large = rows.find((row) => row.id === 'set-2-large');
    expect(large).toMatchObject({ oxyVariant: 'w640', width: 640, height: 640 });
    // The repoint queued Syra's references to it, for both artists.
    const ops = [
      ...(await getDb().execute<{ entity_id: string }>(sql`
        select entity_id from oxy_file_reference_ops where op = 'add' order by entity_id
      `)),
    ];
    expect(ops.map((op) => op.entity_id)).toEqual(['ce-1', 'ce-2']);
  });

  it("copies a person's upload into their account, and takes over one whose account is gone", async () => {
    oxy.localUsers.add('person-1');
    await legacySingle('mine', await png('#aa0000', 20), 'person-1');
    await legacySingle('orphan', await png('#00aa00', 20), 'deleted-account');
    await playlist('p-1', 'mine');
    await playlist('p-2', 'orphan');

    const { lines } = await run(true);

    const mine = lines.find((line) => line.ids[0] === 'mine');
    const orphan = lines.find((line) => line.ids[0] === 'orphan');
    expect(mine).toMatchObject({ owner: 'account', outcome: 'copied' });
    expect(oxy.files.get(mine?.fileId as string)?.ownerUserId).toBe('person-1');
    expect(orphan).toMatchObject({ owner: 'application', ownerFallback: true, outcome: 'copied' });
  });

  it('leaves what is not Syra’s to copy, and marks a missing object so nothing serves it', async () => {
    await legacySingle('garbage', await png('#000000', 8));
    await legacySingle('gone', await png('#111111', 8));
    bucket.delete('images/gone/x');
    await playlist('p-1', 'gone');
    await legacySingle('alia-cover', await png('#222222', 8), 'show-owner');
    await getDb().execute(sql`
      insert into podcasts (id, title, source, image_id) values ('show-1', 'S', 'syra', 'alia-cover')
    `);
    await getDb().execute(sql`
      insert into podcast_sources (id, podcast_id, position, provider, external_id, imported_at)
      values ('src-1', 'show-1', 0, 'alia', 'series-1', '2026-10-16')
    `);

    const { lines } = await run(true);

    expect(Object.fromEntries(lines.map((line) => [line.ids[0], line.outcome]))).toEqual({
      garbage: 'unreferenced',
      gone: 'missing_object',
      'alia-cover': 'alia_handover',
    });
    const [gone] = await getDb().select().from(imageAssets).where(eq(imageAssets.id, 'gone'));
    expect(gone?.servingStatus).toBe('missing');
    expect(oxy.files.size).toBe(0);
  });

  it('refuses a set whose original does not hash to what was recorded', async () => {
    const ids = await legacySet('set-1', await png('#123456'));
    await artist('ce-1', ids);
    bucket.set('images/set-1-original/x', await png('#654321'));
    const { stats } = await run(true);
    expect(stats.hash_mismatch).toBe(1);
    // Nothing points at what Oxy imported, so nothing references it: Oxy collects it.
    const rows = await getDb().select().from(imageAssets);
    expect(rows.every((row) => row.oxyFileId === null)).toBe(true);
    expect(oxy.refs.size).toBe(0);
  });

  it("imports sets from Syra's own image URL, 50 to a call", async () => {
    for (let index = 0; index < 51; index += 1) {
      const color = `#${index.toString(16).padStart(2, '0')}3456`;
      await artist(`ce-${index}`, await legacySet(`set-${index}`, await png(color, 16)));
    }
    const { stats } = await run(true);
    expect(stats.copied).toBe(51);
    const calls = oxy.calls.filter((call) => call.method === 'importAppFiles');
    // Two calls, run side by side: one of 50, one of 1.
    expect(calls.map((call) => call.args[0]).sort()).toEqual([1, 50]);
    expect(oxy.calls.some((call) => call.method === 'uploadAppFile')).toBe(false);
    expect([...oxy.sources.keys()]).toContain(`${ORIGIN}/api/images/set-0-original`);
  }, 60_000);

  it('waits out a 429 and makes the same import again, failing nothing', async () => {
    await artist('ce-1', await legacySet('set-1', await png('#123456')));
    oxy.failNext.set(
      'importAppFiles',
      Object.assign(new FakeOxyError(429, 'Too many'), {
        details: { retryAfterSeconds: 42 },
      }),
    );
    waits.length = 0;
    const { stats } = await run(true);
    expect(stats).toMatchObject({ copied: 1, failed: 0 });
    expect(waits).toContain(42_000);
  });

  it('marks a set missing when Syra cannot serve its original because the bucket lost it', async () => {
    const ids = await legacySet('set-1', await png('#123456'));
    await artist('ce-1', ids);
    bucket.delete('images/set-1-original/x');
    const { lines } = await run(true);
    expect(lines).toEqual([
      expect.objectContaining({ kind: 'catalog_set', outcome: 'missing_object' }),
    ]);
    const rows = await getDb().select().from(imageAssets);
    expect(rows.every((row) => row.servingStatus === 'missing')).toBe(true);
  });

  it('refuses to import without an https origin to import from', async () => {
    await artist('ce-1', await legacySet('set-1', await png('#123456')));
    await expect(
      migrateImagesToOxy({ apply: true, publicOrigin: '', pacer: pacer() }),
    ).rejects.toThrow(/STREAM_KEY_BASE_URL/);
  });

  it('finds nothing left to do on a second run', async () => {
    await artist('ce-1', await legacySet('set-1', await png('#123456')));
    await run(true);
    const again = await run(true);
    expect(again.stats.units).toBe(0);
  });
});

describe('migrateImagesToOxy — house, room and series images', () => {
  const bucketUrl = (key: string) => `https://syra-audio.s3.us-west-2.amazonaws.com/${key}`;

  it("copies a bucket image into the space owner's account and leaves an external link alone", async () => {
    oxy.localUsers.add('house-owner');
    bucket.set('agora/houses/h-1/avatar.webp', await png('#335577', 64));
    await getDb()
      .insert(houses)
      .values({
        id: 'h-1',
        name: 'H',
        createdBy: 'house-owner',
        avatar: bucketUrl('agora/houses/h-1/avatar.webp'),
        coverImage: 'https://elsewhere.example/cover.jpg',
      });
    expect(cdnUrlToKey(bucketUrl('agora/houses/h-1/avatar.webp'))).toBe(
      'agora/houses/h-1/avatar.webp',
    );

    const { lines } = await run(true);

    const [house] = await getDb().select().from(houses).where(eq(houses.id, 'h-1'));
    expect(house?.avatar).toBeNull();
    expect(oxy.files.get(house?.avatarFileId as string)?.ownerUserId).toBe('house-owner');
    expect(house?.coverImage).toBe('https://elsewhere.example/cover.jpg');
    expect(house?.coverImageFileId).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'house_avatar', owner: 'account', outcome: 'copied' });
  });
});
