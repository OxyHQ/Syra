import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { UserUploadModel } from '../../models/UserUpload';
import { TrackModel } from '../../models/Track';
import { ingestUserUpload } from './ingestUserUpload';
import { LOCKER_HLS_BITRATES_KBPS } from './hlsPackager';
import type { PackageOptions, PackageResult } from './hlsPackager';
import type { StoreHlsTarget, StoredHls } from './hlsStorage';
import type { ProbedAudio } from './probeAudio';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

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

async function createUpload(overrides: Record<string, unknown> = {}) {
  return UserUploadModel.create({
    ownerOxyUserId: OWNER_ID,
    title: 'A Private File',
    duration: 0,
    sizeBytes: 12_345,
    sha256: 'a'.repeat(64),
    status: 'processing',
    audioSource: { key: 'locker/oxy-locker-owner/u.flac', format: 'flac' },
    ...overrides,
  });
}

describe('ingestUserUpload', () => {
  it('happy path: status → ready with hls, master key and loudness written', async () => {
    const upload = await createUpload();
    const uploadId = upload._id.toString();

    await ingestUserUpload(uploadId, happyDeps);

    const reloaded = await UserUploadModel.findById(uploadId);
    expect(reloaded?.status).toBe('ready');
    expect(reloaded?.hlsMasterKey).toBe(CANNED_STORED.hlsMasterKey);
    expect(reloaded?.hls).toHaveLength(1);
    expect(reloaded?.loudnessLufs).toBe(-9.8);
  });

  it('writes the probed duration, bitrate and codec back onto the upload', async () => {
    const upload = await createUpload();
    const uploadId = upload._id.toString();

    await ingestUserUpload(uploadId, happyDeps);

    const reloaded = await UserUploadModel.findById(uploadId);
    expect(reloaded?.duration).toBe(CANNED_PROBE.durationSec);
    expect(reloaded?.bitrateKbps).toBe(CANNED_PROBE.bitrateKbps);
    expect(reloaded?.codec).toBe(CANNED_PROBE.codec);
  });

  it('always packages the single-rendition locker ladder', async () => {
    // The cost saving is the entire reason the locker has its own ingest path;
    // a regression to the catalog ladder would triple it silently.
    const upload = await createUpload();
    let received: PackageOptions | undefined;

    await ingestUserUpload(upload._id.toString(), {
      ...happyDeps,
      packageHls: async (opts: PackageOptions) => {
        received = opts;
        return CANNED_PACKAGE_RESULT;
      },
    });

    expect(received?.bitratesKbps).toEqual([...LOCKER_HLS_BITRATES_KBPS]);
  });

  it('stores HLS under hls/uploads/{owner}/{uploadId}/, not the catalog artist space', async () => {
    const upload = await createUpload();
    const uploadId = upload._id.toString();
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
    const upload = await createUpload({
      audioSource: { key: 'locker/oxy-locker-owner/specific.mp3', format: 'mp3' },
    });
    let received: { key: string; format: string } | undefined;

    await ingestUserUpload(upload._id.toString(), {
      ...happyDeps,
      fetchSource: async (key: string, format: string) => {
        received = { key, format };
        return { localPath: '/tmp/fake-locker.mp3', cleanup: () => {} };
      },
    });

    expect(received).toEqual({ key: 'locker/oxy-locker-owner/specific.mp3', format: 'mp3' });
  });

  it('never touches the Track collection', async () => {
    // The collections are separate so a private file cannot reach a catalog
    // query; an ingest that wrote a Track would undo that by itself.
    const upload = await createUpload();

    await ingestUserUpload(upload._id.toString(), happyDeps);

    expect(await TrackModel.countDocuments({})).toBe(0);
  });

  it('failure path: packaging throws → status failed, error rethrown', async () => {
    const upload = await createUpload();
    const uploadId = upload._id.toString();

    await expect(
      ingestUserUpload(uploadId, {
        ...happyDeps,
        packageHls: async (): Promise<PackageResult> => {
          throw new Error('ffmpeg exploded');
        },
      }),
    ).rejects.toThrow('ffmpeg exploded');

    const reloaded = await UserUploadModel.findById(uploadId);
    expect(reloaded?.status).toBe('failed');
  });

  it('missing audioSource: rejects and records failed rather than staying processing', async () => {
    const upload = await createUpload({ audioSource: undefined });

    await expect(ingestUserUpload(upload._id.toString(), happyDeps)).rejects.toThrow(
      /no source audio/i,
    );

    const reloaded = await UserUploadModel.findById(upload._id);
    expect(reloaded?.status).toBe('failed');
  });

  it('missing upload: rejects with a clear error', async () => {
    await expect(ingestUserUpload('507f1f77bcf86cd799439011', happyDeps)).rejects.toThrow(
      /upload not found/i,
    );
  });
});
