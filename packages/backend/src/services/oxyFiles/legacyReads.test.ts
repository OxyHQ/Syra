import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { oxyFilesLegacyReads } from '../../db/schema/oxyFiles';
import { flushLegacyReads, pendingLegacyReads, recordLegacyRead } from './legacyReads';
import { spaceImageUrl } from './spaceImages';
import { installFakeOxyFiles, resetOxyFiles } from '../../test/fakeOxyFiles';

/**
 * The legacy-read count is what retires the bucket, so it must neither lose a
 * read nor invent a day of silence: every flush writes a row for EVERY kind (a
 * zero is evidence the counter was alive), and a failed write keeps its counts.
 */

beforeAll(connectDb);
// Counts are module state: another suite's reads must not leak into these.
beforeEach(async () => {
  await flushLegacyReads();
  await clearDb();
});
afterEach(async () => {
  resetOxyFiles();
  await flushLegacyReads();
  await clearDb();
});
afterAll(disconnectDb);

async function stored() {
  return Object.fromEntries(
    (await getDb().select().from(oxyFilesLegacyReads)).map((row) => [
      `${row.day}:${row.kind}`,
      row.reads,
    ]),
  );
}

describe('flushLegacyReads', () => {
  it('adds the pending counts to the day, writing a zero for every kind not read', async () => {
    await flushLegacyReads(new Date('2026-10-16T10:00:00Z'));
    recordLegacyRead('image_asset');
    recordLegacyRead('image_asset');
    recordLegacyRead('house_cover');
    await flushLegacyReads(new Date('2026-10-16T11:00:00Z'));
    recordLegacyRead('image_asset');
    await flushLegacyReads(new Date('2026-10-16T12:00:00Z'));

    expect(await stored()).toEqual({
      '2026-10-16:image_asset': 3,
      '2026-10-16:house_avatar': 0,
      '2026-10-16:house_cover': 1,
      '2026-10-16:room_stream_image': 0,
      '2026-10-16:series_cover': 0,
    });
    expect(pendingLegacyReads().size).toBe(0);
  });
});

describe('spaceImageUrl', () => {
  it('serves the Oxy file first, and counts only a URL that points into the old bucket', async () => {
    installFakeOxyFiles();
    const bucketUrl = 'https://syra-audio.s3.us-west-2.amazonaws.com/agora/houses/h/avatar.webp';

    expect(spaceImageUrl('file-1', bucketUrl, 'house_avatar')).toBe('https://cloud.test/file-1');
    expect(pendingLegacyReads().get('house_avatar') ?? 0).toBe(0);

    expect(spaceImageUrl(null, bucketUrl, 'house_avatar')).toBe(bucketUrl);
    expect(pendingLegacyReads().get('house_avatar')).toBe(1);

    expect(spaceImageUrl(null, 'https://i.ytimg.com/vi/x/hq.jpg', 'room_stream_image')).toBe(
      'https://i.ytimg.com/vi/x/hq.jpg',
    );
    expect(pendingLegacyReads().get('room_stream_image') ?? 0).toBe(0);
    expect(spaceImageUrl(null, null, 'series_cover')).toBeNull();
  });
});
