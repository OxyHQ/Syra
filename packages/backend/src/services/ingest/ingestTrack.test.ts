import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../../test/mongo';
import { TrackModel } from '../../models/Track';
import { ingestTrack } from './ingestTrack';
import { LOCKER_HLS_BITRATES_KBPS } from './hlsPackager';
import { TrackFingerprintModel } from '../../models/TrackFingerprint';
import type { FingerprintResult } from '../uploads/fingerprint';
import type { PackageOptions, PackageResult } from './hlsPackager';
import type { StoreHlsTarget, StoredHls } from './hlsStorage';
import type { ProbedAudio } from './probeAudio';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

// ── Shared fakes ─────────────────────────────────────────────────────────────

const ARTIST_ID = new mongoose.Types.ObjectId().toString();

const CANNED_PACKAGE_RESULT: PackageResult = {
  outputDir: '/tmp/fake-output',
  masterPlaylistPath: 'master.m3u8',
  renditions: [
    { bitrateKbps: 96, playlistPath: '96/stream.m3u8' },
    { bitrateKbps: 160, playlistPath: '160/stream.m3u8' },
    { bitrateKbps: 320, playlistPath: '320/stream.m3u8' },
  ],
  keyHex: 'deadbeefdeadbeefdeadbeefdeadbeef',
  keyUri: '/api/stream/fake-track-id/key',
  loudnessLufs: -12.3,
};

const CANNED_STORED: StoredHls = {
  hls: [
    { manifestKey: 'hls/a/t/96/stream.m3u8', bitrateKbps: 96, encrypted: true },
    { manifestKey: 'hls/a/t/160/stream.m3u8', bitrateKbps: 160, encrypted: true },
    { manifestKey: 'hls/a/t/320/stream.m3u8', bitrateKbps: 320, encrypted: true },
  ],
  hlsMasterKey: 'hls/a/t/master.m3u8',
};

const CANNED_PROBE: ProbedAudio = {
  durationSec: 184.44,
  bitrateKbps: 256,
  codec: 'mp3',
};

const CANNED_FINGERPRINT: FingerprintResult = {
  status: 'ok',
  values: [1, 2, 3, 4, 5],
  durationSec: 184,
};

const happyDeps = {
  fetchSource: async () => ({ localPath: '/tmp/fake.mp3', cleanup: () => {} }),
  probe: async () => CANNED_PROBE,
  fingerprint: async () => CANNED_FINGERPRINT,
  packageHls: async () => CANNED_PACKAGE_RESULT,
  storeHls: async () => CANNED_STORED,
  generatePreview: async () => 'previews/fake-track-id/0.mp3',
};

async function createTrack(overrides: Record<string, unknown> = {}) {
  return TrackModel.create({
    title: 'Test Track',
    artistId: ARTIST_ID,
    artistName: 'Test Artist',
    duration: 180,
    source: 'upload',
    status: 'processing',
    isExplicit: false,
    isAvailable: true,
    audioSource: { url: '/api/audio/fake', format: 'mp3' },
    ...overrides,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ingestTrack', () => {
  it('happy path: status → ready, hls/hlsMasterKey/loudnessLufs written', async () => {
    const track = await createTrack();
    const trackId = track._id.toString();

    await ingestTrack(trackId, happyDeps);

    const reloaded = await TrackModel.findById(trackId);
    expect(reloaded?.status).toBe('ready');
    expect(reloaded?.loudnessLufs).toBe(-12.3);
    expect(reloaded?.hlsMasterKey).toBe('hls/a/t/master.m3u8');
    expect(reloaded?.hls).toHaveLength(3);
    expect(reloaded?.hls?.[0].manifestKey).toBe('hls/a/t/96/stream.m3u8');
    expect(reloaded?.hls?.[0].encrypted).toBe(true);
  });

  it('best-effort preview: generatePreview throwing does not fail ingest', async () => {
    const track = await createTrack();
    const trackId = track._id.toString();

    const previewFailDeps = {
      ...happyDeps,
      generatePreview: async (): Promise<string> => {
        throw new Error('ffmpeg preview clip failed');
      },
    };

    await ingestTrack(trackId, previewFailDeps);

    const reloaded = await TrackModel.findById(trackId);
    expect(reloaded?.status).toBe('ready');
  });

  it('failure path: packageHls throws → status set to failed, error rethrown', async () => {
    const track = await createTrack();
    const trackId = track._id.toString();

    const failDeps = {
      ...happyDeps,
      packageHls: async (): Promise<PackageResult> => {
        throw new Error('ffmpeg exploded');
      },
    };

    await expect(ingestTrack(trackId, failDeps)).rejects.toThrow('ffmpeg exploded');

    const reloaded = await TrackModel.findById(trackId);
    expect(reloaded?.status).toBe('failed');
  });

  it('missing track: rejects with clear error', async () => {
    const absentId = new mongoose.Types.ObjectId().toString();
    await expect(ingestTrack(absentId, happyDeps)).rejects.toThrow();
  });

  it('missing audioSource: rejects with clear error', async () => {
    const track = await createTrack({ audioSource: undefined });
    await expect(ingestTrack(track._id.toString(), happyDeps)).rejects.toThrow(
      /no source audio/i,
    );

    const reloaded = await TrackModel.findById(track._id);
    expect(reloaded?.status).toBe('failed');
  });

  it('writes the probed duration and bitrate onto audioSource', async () => {
    // Both fields exist in the schema and were never written by any code path
    // before ingest started probing the source.
    const track = await createTrack({
      audioSource: { url: '/api/audio/fake', format: 'mp3' },
    });
    const trackId = track._id.toString();
    expect(track.audioSource?.duration).toBeUndefined();
    expect(track.audioSource?.bitrate).toBeUndefined();

    await ingestTrack(trackId, happyDeps);

    const reloaded = await TrackModel.findById(trackId);
    expect(reloaded?.audioSource?.duration).toBe(CANNED_PROBE.durationSec);
    expect(reloaded?.audioSource?.bitrate).toBe(CANNED_PROBE.bitrateKbps);
  });

  it('a source with no declared bitrate leaves audioSource.bitrate unset', async () => {
    const track = await createTrack();
    const trackId = track._id.toString();

    await ingestTrack(trackId, {
      ...happyDeps,
      probe: async (): Promise<ProbedAudio> => ({ durationSec: 12.5 }),
    });

    const reloaded = await TrackModel.findById(trackId);
    expect(reloaded?.status).toBe('ready');
    expect(reloaded?.audioSource?.duration).toBe(12.5);
    expect(reloaded?.audioSource?.bitrate).toBeUndefined();
  });

  it('probe failure fails the ingest before any packaging happens', async () => {
    const track = await createTrack();
    const trackId = track._id.toString();
    let packaged = false;

    await expect(
      ingestTrack(trackId, {
        ...happyDeps,
        probe: async (): Promise<ProbedAudio> => {
          throw new Error('ffprobe: no usable duration');
        },
        packageHls: async () => {
          packaged = true;
          return CANNED_PACKAGE_RESULT;
        },
      }),
    ).rejects.toThrow(/no usable duration/);

    expect(packaged).toBe(false);
    const reloaded = await TrackModel.findById(trackId);
    expect(reloaded?.status).toBe('failed');
  });

  it('passes the requested bitrate ladder through to the packager', async () => {
    const track = await createTrack();
    let received: PackageOptions | undefined;

    await ingestTrack(
      track._id.toString(),
      {
        ...happyDeps,
        packageHls: async (opts: PackageOptions) => {
          received = opts;
          return CANNED_PACKAGE_RESULT;
        },
      },
      { bitratesKbps: LOCKER_HLS_BITRATES_KBPS },
    );

    expect(received?.bitratesKbps).toEqual([...LOCKER_HLS_BITRATES_KBPS]);
  });

  it('writes a TrackFingerprint row so the acoustic tiers have something to match', async () => {
    /**
     * Nothing wrote this collection before. With no row, `matchCatalog`'s
     * Chromaprint tier queries an empty duration bucket on every upload and can
     * never match, and a copyright takedown cannot find locker copies of the same
     * recording that hash differently — a safe-harbour obligation, not a nicety.
     */
    const track = await createTrack();
    const trackId = track._id.toString();
    expect(await TrackFingerprintModel.countDocuments({})).toBe(0);

    await ingestTrack(trackId, happyDeps);

    const row = await TrackFingerprintModel.findOne({ trackId }).lean();
    expect(row?.fingerprint).toEqual(CANNED_FINGERPRINT.status === 'ok' ? CANNED_FINGERPRINT.values : []);
    expect(row?.fingerprintDurationSec).toBe(184);
  });

  it('leaves no row when fpcalc is unavailable, rather than an empty one', async () => {
    // An empty row still matches the duration bucket, so it is returned as a
    // candidate that compares against nothing — strictly worse than no row.
    const track = await createTrack();
    const trackId = track._id.toString();

    await ingestTrack(trackId, {
      ...happyDeps,
      fingerprint: async (): Promise<FingerprintResult> => ({
        status: 'unavailable',
        reason: 'fpcalc (Chromaprint) is not installed',
      }),
    });

    expect(await TrackFingerprintModel.findOne({ trackId })).toBeNull();
    // …and the track is still playable. An unindexed track beats a failed ingest.
    expect((await TrackModel.findById(trackId))?.status).toBe('ready');
  });

  it('leaves no row when fpcalc rejects the file, and still finishes the ingest', async () => {
    const track = await createTrack();
    const trackId = track._id.toString();

    await ingestTrack(trackId, {
      ...happyDeps,
      fingerprint: async (): Promise<FingerprintResult> => ({
        status: 'failed',
        reason: 'fpcalc failed: unsupported',
      }),
    });

    expect(await TrackFingerprintModel.findOne({ trackId })).toBeNull();
    expect((await TrackModel.findById(trackId))?.status).toBe('ready');
  });

  it('refuses an empty fingerprint instead of storing an unmatchable row', async () => {
    const track = await createTrack();
    const trackId = track._id.toString();

    await ingestTrack(trackId, {
      ...happyDeps,
      fingerprint: async (): Promise<FingerprintResult> => ({
        status: 'ok',
        values: [],
        durationSec: 184,
      }),
    });

    expect(await TrackFingerprintModel.findOne({ trackId })).toBeNull();
  });

  it('does not re-run fpcalc when the row already exists (the promote path)', async () => {
    // The promote path copies the UserUpload's fingerprint across, so ingest must
    // honour it rather than spending seconds recomputing the same values.
    const track = await createTrack();
    const trackId = track._id.toString();
    await TrackFingerprintModel.create({
      trackId,
      fingerprint: [9, 9, 9],
      fingerprintDurationSec: 42,
    });

    let fingerprintCalls = 0;
    await ingestTrack(trackId, {
      ...happyDeps,
      fingerprint: async (): Promise<FingerprintResult> => {
        fingerprintCalls += 1;
        return CANNED_FINGERPRINT;
      },
    });

    expect(fingerprintCalls).toBe(0);
    const row = await TrackFingerprintModel.findOne({ trackId }).lean();
    expect(row?.fingerprint).toEqual([9, 9, 9]);
    expect(row?.fingerprintDurationSec).toBe(42);
  });

  it('a fingerprinting crash does not fail an otherwise-successful ingest', async () => {
    const track = await createTrack();
    const trackId = track._id.toString();

    await ingestTrack(trackId, {
      ...happyDeps,
      fingerprint: async (): Promise<FingerprintResult> => {
        throw new Error('fpcalc segfaulted');
      },
    });

    expect((await TrackModel.findById(trackId))?.status).toBe('ready');
    expect(await TrackFingerprintModel.findOne({ trackId })).toBeNull();
  });

  it('omits the ladder entirely when no option is given, so the packager default applies', async () => {
    const track = await createTrack();
    let received: PackageOptions | undefined;

    await ingestTrack(track._id.toString(), {
      ...happyDeps,
      packageHls: async (opts: PackageOptions) => {
        received = opts;
        return CANNED_PACKAGE_RESULT;
      },
    });

    expect(received).toBeDefined();
    expect(received?.bitratesKbps).toBeUndefined();
  });
});
