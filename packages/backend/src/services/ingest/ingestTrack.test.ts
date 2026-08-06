import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import {
  catalogEntities,
  trackFingerprints,
  trackHlsRenditions,
  tracks,
} from '../../db/schema/catalog';
import { ingestTrack } from './ingestTrack';
import { LOCKER_HLS_BITRATES_KBPS } from './hlsPackager';
import type { FingerprintResult } from '../uploads/fingerprint';
import type { PackageOptions, PackageResult } from './hlsPackager';
import type { StoreHlsTarget, StoredHls } from './hlsStorage';
import type { ProbedAudio } from './probeAudio';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/**
 * The track row plus its rendition ladder, which is a CHILD TABLE now.
 *
 * The Mongo assertions read `reloaded.hls[0]`; the ladder lives in
 * `track_hls_renditions` and its order is `position`, so a reader without the
 * `ORDER BY` would compare against whatever row Postgres returned first.
 */
/** The fingerprint row for a track, or undefined — a child table read. */
async function fingerprintFor(trackId: string) {
  const [row] = await getDb()
    .select()
    .from(trackFingerprints)
    .where(eq(trackFingerprints.trackId, trackId))
    .limit(1);
  return row;
}

async function fingerprintCount(): Promise<number> {
  return (await getDb().select({ id: trackFingerprints.id }).from(trackFingerprints)).length;
}

async function reload(trackId: string) {
  const [track] = await getDb().select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
  if (!track) return undefined;

  const hls = await getDb()
    .select()
    .from(trackHlsRenditions)
    .where(eq(trackHlsRenditions.trackId, trackId))
    .orderBy(asc(trackHlsRenditions.position));

  return { ...track, hls };
}

// ── Shared fakes ─────────────────────────────────────────────────────────────

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

async function createTrack(
  overrides: Partial<typeof tracks.$inferInsert> = {}
): Promise<{ id: string }> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: 'Test Artist',
      nameKey: `test-artist-${suffix}`,
      source: 'upload',
    })
    .returning({ id: catalogEntities.id });

  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: 'Test Track',
      artistId: artist?.id ?? '',
      artistName: 'Test Artist',
      duration: 180,
      source: 'upload',
      status: 'processing',
      isExplicit: false,
      isAvailable: true,
      audioSourceUrl: '/api/audio/fake',
      audioSourceFormat: 'mp3',
      ...overrides,
    })
    .returning({ id: tracks.id });

  if (!track) throw new Error('createTrack: insert returned no row');
  return track;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ingestTrack', () => {
  it('happy path: status → ready, hls/hlsMasterKey/loudnessLufs written', async () => {
    const track = await createTrack();
    const trackId = track.id;

    await ingestTrack(trackId, happyDeps);

    const reloaded = await reload(trackId);
    expect(reloaded?.status).toBe('ready');
    expect(reloaded?.loudnessLufs).toBe(-12.3);
    expect(reloaded?.hlsMasterKey).toBe('hls/a/t/master.m3u8');
    expect(reloaded?.hls).toHaveLength(3);
    expect(reloaded?.hls[0].manifestKey).toBe('hls/a/t/96/stream.m3u8');
    expect(reloaded?.hls[0].encrypted).toBe(true);
  });

  it('best-effort preview: generatePreview throwing does not fail ingest', async () => {
    const track = await createTrack();
    const trackId = track.id;

    const previewFailDeps = {
      ...happyDeps,
      generatePreview: async (): Promise<string> => {
        throw new Error('ffmpeg preview clip failed');
      },
    };

    await ingestTrack(trackId, previewFailDeps);

    const reloaded = await reload(trackId);
    expect(reloaded?.status).toBe('ready');
  });

  it('failure path: packageHls throws → status set to failed, error rethrown', async () => {
    const track = await createTrack();
    const trackId = track.id;

    const failDeps = {
      ...happyDeps,
      packageHls: async (): Promise<PackageResult> => {
        throw new Error('ffmpeg exploded');
      },
    };

    await expect(ingestTrack(trackId, failDeps)).rejects.toThrow('ffmpeg exploded');

    const reloaded = await reload(trackId);
    expect(reloaded?.status).toBe('failed');
  });

  it('missing track: rejects with clear error', async () => {
    // An id shaped like a real one that no row carries.
    const absentId = uuidv7();
    await expect(ingestTrack(absentId, happyDeps)).rejects.toThrow();
  });

  it('missing audioSource: rejects with clear error', async () => {
    const track = await createTrack({ audioSourceUrl: null, audioSourceFormat: null });
    await expect(ingestTrack(track.id, happyDeps)).rejects.toThrow(
      /no source audio/i,
    );

    const reloaded = await reload(track.id);
    expect(reloaded?.status).toBe('failed');
  });

  it('writes the probed duration and bitrate onto audioSource', async () => {
    // Both fields exist in the schema and were never written by any code path
    // before ingest started probing the source.
    const track = await createTrack({
      audioSourceUrl: '/api/audio/fake',
      audioSourceFormat: 'mp3',
    });
    const trackId = track.id;
    const before = await reload(trackId);
    expect(before?.audioSourceDuration).toBeNull();
    expect(before?.audioSourceBitrate).toBeNull();

    await ingestTrack(trackId, happyDeps);

    const reloaded = await reload(trackId);
    expect(reloaded?.audioSourceDuration).toBe(CANNED_PROBE.durationSec);
    expect(reloaded?.audioSourceBitrate).toBe(CANNED_PROBE.bitrateKbps);
  });

  it('a source with no declared bitrate leaves audioSource.bitrate unset', async () => {
    const track = await createTrack();
    const trackId = track.id;

    await ingestTrack(trackId, {
      ...happyDeps,
      probe: async (): Promise<ProbedAudio> => ({ durationSec: 12.5 }),
    });

    const reloaded = await reload(trackId);
    expect(reloaded?.status).toBe('ready');
    expect(reloaded?.audioSourceDuration).toBe(12.5);
    expect(reloaded?.audioSourceBitrate).toBeNull();
  });

  it('probe failure fails the ingest before any packaging happens', async () => {
    const track = await createTrack();
    const trackId = track.id;
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
    const reloaded = await reload(trackId);
    expect(reloaded?.status).toBe('failed');
  });

  it('passes the requested bitrate ladder through to the packager', async () => {
    const track = await createTrack();
    let received: PackageOptions | undefined;

    await ingestTrack(
      track.id,
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
    const trackId = track.id;
    expect(await fingerprintCount()).toBe(0);

    await ingestTrack(trackId, happyDeps);

    const row = await fingerprintFor(trackId);
    expect(row?.fingerprint).toEqual(CANNED_FINGERPRINT.status === 'ok' ? CANNED_FINGERPRINT.values : []);
    expect(row?.fingerprintDurationSec).toBe(184);
  });

  it('leaves no row when fpcalc is unavailable, rather than an empty one', async () => {
    // An empty row still matches the duration bucket, so it is returned as a
    // candidate that compares against nothing — strictly worse than no row.
    const track = await createTrack();
    const trackId = track.id;

    await ingestTrack(trackId, {
      ...happyDeps,
      fingerprint: async (): Promise<FingerprintResult> => ({
        status: 'unavailable',
        reason: 'fpcalc (Chromaprint) is not installed',
      }),
    });

    expect(await fingerprintFor(trackId)).toBeUndefined();
    // …and the track is still playable. An unindexed track beats a failed ingest.
    expect((await reload(trackId))?.status).toBe('ready');
  });

  it('leaves no row when fpcalc rejects the file, and still finishes the ingest', async () => {
    const track = await createTrack();
    const trackId = track.id;

    await ingestTrack(trackId, {
      ...happyDeps,
      fingerprint: async (): Promise<FingerprintResult> => ({
        status: 'failed',
        reason: 'fpcalc failed: unsupported',
      }),
    });

    expect(await fingerprintFor(trackId)).toBeUndefined();
    expect((await reload(trackId))?.status).toBe('ready');
  });

  it('refuses an empty fingerprint instead of storing an unmatchable row', async () => {
    const track = await createTrack();
    const trackId = track.id;

    await ingestTrack(trackId, {
      ...happyDeps,
      fingerprint: async (): Promise<FingerprintResult> => ({
        status: 'ok',
        values: [],
        durationSec: 184,
      }),
    });

    expect(await fingerprintFor(trackId)).toBeUndefined();
  });

  it('does not re-run fpcalc when the row already exists (the promote path)', async () => {
    // The promote path copies the UserUpload's fingerprint across, so ingest must
    // honour it rather than spending seconds recomputing the same values.
    const track = await createTrack();
    const trackId = track.id;
    await getDb().insert(trackFingerprints).values({
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
    const row = await fingerprintFor(trackId);
    expect(row?.fingerprint).toEqual([9, 9, 9]);
    expect(row?.fingerprintDurationSec).toBe(42);
  });

  it('a fingerprinting crash does not fail an otherwise-successful ingest', async () => {
    const track = await createTrack();
    const trackId = track.id;

    await ingestTrack(trackId, {
      ...happyDeps,
      fingerprint: async (): Promise<FingerprintResult> => {
        throw new Error('fpcalc segfaulted');
      },
    });

    expect((await reload(trackId))?.status).toBe('ready');
    expect(await fingerprintFor(trackId)).toBeUndefined();
  });

  it('omits the ladder entirely when no option is given, so the packager default applies', async () => {
    const track = await createTrack();
    let received: PackageOptions | undefined;

    await ingestTrack(track.id, {
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
