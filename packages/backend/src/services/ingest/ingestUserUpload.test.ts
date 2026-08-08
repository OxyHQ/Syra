import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { connectDb, clearDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { tracks } from '../../db/schema/catalog';
import { userUploads } from '../../db/schema/creators';
import { loadUploadHls } from '../../db/creators/uploads';
import { ingestUserUpload } from './ingestUserUpload';
import { LOCKER_HLS_BITRATES_KBPS } from './hlsPackager';
import type { PackageOptions, PackageResult } from './hlsPackager';
import type { StoreHlsTarget, StoredHls } from './hlsStorage';
import type { ProbedAudio } from './probeAudio';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const OWNER_ID = 'oxy-locker-owner';

const CANNED_PACKAGE_RESULT: PackageResult = {
  outputDir: '/tmp/fake-locker-output',
  masterPlaylistPath: 'master.m3u8',
  renditions: [{ bitrateKbps: 160, playlistPath: '160/stream.m3u8' }],
  keyHex: 'cafebabecafebabecafebabecafebabe',
  keyUri: '/api/uploads/fake-upload-id/key',
  loudnessLufs: -9.8,
};

const CANNED_STORED: StoredHls = {
  hls: [{ manifestKey: 'hls/oxy-locker-owner/u/160/stream.m3u8', bitrateKbps: 160, encrypted: true }],
  hlsMasterKey: 'hls/oxy-locker-owner/u/master.m3u8',
};

const CANNED_PROBE: ProbedAudio = { durationSec: 241.7, bitrateKbps: 320, codec: 'flac' };

const happyDeps = {
  fetchSource: async () => ({ localPath: '/tmp/fake-locker.flac', cleanup: () => {} }),
  probe: async () => CANNED_PROBE,
  packageHls: async () => CANNED_PACKAGE_RESULT,
  storeHls: async () => CANNED_STORED,
};

type UploadOverrides = Partial<typeof userUploads.$inferInsert>;

async function createUpload(overrides: UploadOverrides = {}): Promise<string> {
  const [upload] = await getDb()
    .insert(userUploads)
    .values({
      ownerOxyUserId: OWNER_ID,
      title: 'A Private File',
      duration: 0,
      sizeBytes: 12_345,
      sha256: 'a'.repeat(64),
      status: 'processing',
      audioSourceKey: 'locker/oxy-locker-owner/u.flac',
      audioSourceFormat: 'flac',
      ...overrides,
    })
    .returning({ id: userUploads.id });
  return upload.id;
}

/** The stored row, read back directly rather than through a production helper. */
async function reload(uploadId: string) {
  const [row] = await getDb().select().from(userUploads).where(eq(userUploads.id, uploadId));
  return row;
}

describe('ingestUserUpload', () => {
  it('happy path: status → ready with hls, master key and loudness written', async () => {
    const uploadId = await createUpload();

    await ingestUserUpload(uploadId, happyDeps);

    const reloaded = await reload(uploadId);
    expect(reloaded?.status).toBe('ready');
    expect(reloaded?.hlsMasterKey).toBe(CANNED_STORED.hlsMasterKey);
    // The ladder is a CHILD TABLE now, so "has one rendition" is a second read
    // rather than a field on the row — and the write that fills it is inside
    // the same transaction as the `ready` status above.
    expect((await loadUploadHls([uploadId])).get(uploadId)).toHaveLength(1);
    expect(reloaded?.loudnessLufs).toBe(-9.8);
  });

  it('writes the probed duration, bitrate and codec back onto the upload', async () => {
    const uploadId = await createUpload();

    await ingestUserUpload(uploadId, happyDeps);

    const reloaded = await reload(uploadId);
    expect(reloaded?.duration).toBe(CANNED_PROBE.durationSec);
    // `?? null`, because these columns are nullable and the probe's type is
    // optional — comparing `number | null` against `number | undefined` is what
    // `tsc` refuses, and the refusal is right: an unprobed file stores null.
    expect(reloaded?.bitrateKbps).toBe(CANNED_PROBE.bitrateKbps ?? null);
    expect(reloaded?.codec).toBe(CANNED_PROBE.codec ?? null);
  });

  it('always packages the single-rendition locker ladder', async () => {
    // The cost saving is the entire reason the locker has its own ingest path;
    // a regression to the catalog ladder would triple it silently.
    const uploadId = await createUpload();
    let received: PackageOptions | undefined;

    await ingestUserUpload(uploadId, {
      ...happyDeps,
      packageHls: async (opts: PackageOptions) => {
        received = opts;
        return CANNED_PACKAGE_RESULT;
      },
    });

    expect(received?.bitratesKbps).toEqual([...LOCKER_HLS_BITRATES_KBPS]);
  });

  it('stores HLS under hls/uploads/{owner}/{uploadId}/, not the catalog artist space', async () => {
    const uploadId = await createUpload();
    let received: StoreHlsTarget | undefined;

    await ingestUserUpload(uploadId, {
      ...happyDeps,
      storeHls: async (_result: PackageResult, target: StoreHlsTarget) => {
        received = target;
        return CANNED_STORED;
      },
    });

    expect(received?.recordId).toBe(uploadId);
    // The built key must land in the locker's own space and keep the upload id
    // as a whole segment, or a takedown cannot sweep the directory.
    expect(received?.buildKey('master.m3u8')).toBe(
      `hls/uploads/${OWNER_ID}/${uploadId}/master.m3u8`,
    );
  });

  it('reads the source key recorded on the upload', async () => {
    const uploadId = await createUpload({
      audioSourceKey: 'locker/oxy-locker-owner/specific.mp3',
      audioSourceFormat: 'mp3',
    });
    let received: { key: string; format: string } | undefined;

    await ingestUserUpload(uploadId, {
      ...happyDeps,
      fetchSource: async (key: string, format: string) => {
        received = { key, format };
        return { localPath: '/tmp/fake-locker.mp3', cleanup: () => {} };
      },
    });

    expect(received).toEqual({ key: 'locker/oxy-locker-owner/specific.mp3', format: 'mp3' });
  });

  it('never touches the tracks table', async () => {
    // The two tables are separate so a private file cannot reach a catalog
    // query; an ingest that wrote a track would undo that by itself.
    const uploadId = await createUpload();

    await ingestUserUpload(uploadId, happyDeps);

    const [counted] = await getDb().select({ total: sql<number>`count(*)::int` }).from(tracks);
    expect(counted.total).toBe(0);
  });

  it('failure path: packaging throws → status failed, error rethrown', async () => {
    const uploadId = await createUpload();

    await expect(
      ingestUserUpload(uploadId, {
        ...happyDeps,
        packageHls: async (): Promise<PackageResult> => {
          throw new Error('ffmpeg exploded');
        },
      }),
    ).rejects.toThrow('ffmpeg exploded');

    expect((await reload(uploadId))?.status).toBe('failed');
  });

  it('missing source key: rejects and records failed rather than staying processing', async () => {
    const uploadId = await createUpload({ audioSourceKey: null, audioSourceFormat: null });

    await expect(ingestUserUpload(uploadId, happyDeps)).rejects.toThrow(/no source audio/i);

    expect((await reload(uploadId))?.status).toBe('failed');
  });

  /**
   * A key with no FORMAT beside it is a shape the embedded `audioSource`
   * subdocument could not produce and two flattened columns can — so it is a
   * fixture the port introduced the need for, not one it inherited.
   */
  it('a source key with no format is also refused', async () => {
    const uploadId = await createUpload({ audioSourceFormat: null });

    await expect(ingestUserUpload(uploadId, happyDeps)).rejects.toThrow(/no source audio/i);

    expect((await reload(uploadId))?.status).toBe('failed');
  });

  it('missing upload: rejects with a clear error', async () => {
    await expect(
      ingestUserUpload('0199e2c0-0000-7000-8000-000000000000', happyDeps),
    ).rejects.toThrow(/upload not found/i);
  });
});
