/**
 * The fingerprint backfill, and the compliance path it exists to feed.
 *
 * This is the most consequential of the three loaders, which is why the last
 * block drives the REAL takedown purge across the import rather than asserting
 * that rows appeared. `purgeLockerCopiesOfTrack` reports
 * `acousticMatchingAvailable`, and that flag is the whole argument: without a
 * fingerprint row, "no re-encode was found" and "re-encodes were never looked
 * for" are the same observable outcome, and for a work a rightsholder has
 * identified those are very different answers.
 *
 * BOTH databases. The catalogue side (artist, track, fingerprint) is Postgres;
 * the locker is `user_uploads`, Task 13's vertical, still Mongoose.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { Readable } from 'stream';
import mongoose from 'mongoose';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clear, connect, disconnect } from '../test/mongo';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, trackFingerprints, tracks } from '../db/schema/catalog';
import { indexTrackAcoustically } from '../db/catalog/fingerprints';
import { UserUploadModel } from '../models/UserUpload';
import {
  purgeLockerCopiesOfTrack,
  type LockerPurgeDeps,
  type LockerRemovalNotice,
} from '../services/compliance/takedown';
import { backfillTrackFingerprints, type BackfillDeps } from './backfillTrackFingerprints';

beforeAll(async () => {
  await connect();
  await connectDb();
});
afterEach(async () => {
  await clear();
  await clearDb();
});
afterAll(async () => {
  await disconnect();
  await disconnectDb();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function makeArtist(): Promise<string> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: `An Artist ${suffix}`,
      nameKey: `an-artist-${suffix}`,
      source: 'upload',
    })
    .returning({ id: catalogEntities.id });
  if (!artist) throw new Error('makeArtist: insert returned no row');
  return artist.id;
}

async function makeTrack(
  artistId: string,
  overrides: Partial<typeof tracks.$inferInsert> = {},
): Promise<string> {
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: 'A Recording',
      artistId,
      artistName: 'An Artist',
      duration: 210,
      source: 'upload',
      status: 'ready',
      ...overrides,
    })
    .returning({ id: tracks.id });
  if (!track) throw new Error('makeTrack: insert returned no row');
  return track.id;
}

/** A track with audio, i.e. one the backfill will actually try to fingerprint. */
function playable(overrides: Partial<typeof tracks.$inferInsert> = {}) {
  return { audioSourceUrl: '/api/audio/x', audioSourceFormat: 'mp3' as const, ...overrides };
}

/**
 * A deterministic pseudo-fingerprint, long enough to clear the comparator's
 * minimum overlap — the same generator `takedown.test.ts` uses, so the two
 * suites agree about what "the same recording" looks like.
 */
function makeFingerprint(seed = 0x1234, items = 1600): number[] {
  const values: number[] = [];
  let state = seed >>> 0;
  for (let i = 0; i < items; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values.push(state | 0);
  }
  return values;
}

/** Flip roughly `rate` of the bits — a different encoding of the same recording. */
function perturb(fingerprint: number[], rate: number): number[] {
  let state = 0x9e3779b9;
  return fingerprint.map((value) => {
    let out = value;
    for (let bit = 0; bit < 32; bit += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      if (state / 0x100000000 < rate) out ^= 1 << bit;
    }
    return out | 0;
  });
}

/**
 * S3 and `fpcalc`, replaced by parameters rather than by `mock.module` — the
 * latter would be process-GLOBAL in bun and would silently swap S3 out for every
 * other test file in the run.
 */
function deps(overrides: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    streamAudio: async () => ({
      stream: Readable.from([Buffer.from('fake audio bytes')]),
      contentLength: 16,
    }),
    fingerprint: async () => ({
      status: 'ok' as const,
      values: makeFingerprint(),
      durationSec: 210,
    }),
    ...overrides,
  };
}

async function readFingerprint(trackId: string) {
  const [row] = await getDb()
    .select()
    .from(trackFingerprints)
    .where(eq(trackFingerprints.trackId, trackId))
    .limit(1);
  return row;
}

const ZERO_STATS = { scanned: 0, indexed: 0, skipped: 0, failed: 0, rejected: 0, vanished: 0 };

/**
 * The "nothing to do" paths, which is what a first production dry run actually
 * hits. A script that divides by zero or prints a confusing summary when the
 * catalogue is empty is discovered during a deploy otherwise — and a deploy is
 * the worst place to learn that a report cannot be trusted.
 */
describe('backfillTrackFingerprints — nothing to do', () => {
  it('reports all zeros against an EMPTY catalogue, without throwing', async () => {
    expect(await backfillTrackFingerprints({ dryRun: true }, deps())).toEqual(ZERO_STATS);
  });

  it('ignores tracks that have no audio to fingerprint', async () => {
    // A track still processing, or one whose source was dropped, has nothing to
    // read. It must not be counted as failed — that would make a healthy run
    // look broken and hide the tracks that genuinely could not be read.
    const artistId = await makeArtist();
    await makeTrack(artistId, { title: 'Still processing', status: 'processing' });
    await makeTrack(artistId, { title: 'No audio source' });

    const stats = await backfillTrackFingerprints({ dryRun: true }, deps());

    expect(stats.scanned).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it('skips what is already indexed, which is what makes a resumed run cheap', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId, playable());
    await indexTrackAcoustically(trackId, { values: [1, 2, 3], durationSec: 210 });

    const stats = await backfillTrackFingerprints({ dryRun: true }, deps());

    // Counted as scanned AND skipped — never re-read from S3.
    expect(stats.scanned).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.indexed).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it('a dry run writes nothing', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId, playable({ audioSourceUrl: '/api/audio/y' }));

    await backfillTrackFingerprints({ dryRun: true }, deps());

    expect(await readFingerprint(trackId)).toBeUndefined();
  });

  it('honours --limit 0 as "do nothing" rather than "no limit"', async () => {
    // `--limit 0` is what somebody types to check the wiring. Reading it as
    // falsy-therefore-unlimited would start a full catalogue pass instead.
    const artistId = await makeArtist();
    await makeTrack(artistId, playable({ audioSourceUrl: '/api/audio/z' }));

    expect((await backfillTrackFingerprints({ dryRun: true, limit: 0 }, deps())).scanned).toBe(0);
  });
});

describe('backfillTrackFingerprints — writing', () => {
  it('writes one fingerprint row per track with audio', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId, playable());

    const stats = await backfillTrackFingerprints({}, deps());

    expect(stats.indexed).toBe(1);
    const row = await readFingerprint(trackId);
    expect(row?.fingerprint).toEqual(makeFingerprint());
    expect(row?.fingerprintDurationSec).toBe(210);
  });

  it('is re-runnable: the second pass skips instead of rewriting', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId, playable());

    await backfillTrackFingerprints({}, deps());
    const first = await readFingerprint(trackId);
    const second = await backfillTrackFingerprints({}, deps());

    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(1);
    // The same ROW — resumability is the table's own state, not a checkpoint file.
    expect((await readFingerprint(trackId))?.id).toBe(first?.id ?? '');
  });

  it('ABORTS the whole run when fpcalc is missing, rather than reporting an empty catalogue', async () => {
    const artistId = await makeArtist();
    await makeTrack(artistId, playable());
    await makeTrack(artistId, playable({ audioSourceUrl: '/api/audio/second' }));

    const stats = await backfillTrackFingerprints(
      {},
      deps({
        fingerprint: async () => ({
          status: 'unavailable' as const,
          reason: 'fpcalc not installed',
        }),
      }),
    );

    // Stopped at the FIRST track: an environment problem is not worth
    // rediscovering forty thousand more times, and a run that "completed" having
    // indexed nothing would look like a catalogue with no fingerprintable audio.
    expect(stats.scanned).toBe(1);
    expect(stats.indexed).toBe(0);
  });

  it('counts unreadable audio as failed and keeps going', async () => {
    const artistId = await makeArtist();
    await makeTrack(artistId, playable());
    const good = await makeTrack(artistId, playable({ audioSourceUrl: '/api/audio/second' }));

    let call = 0;
    const stats = await backfillTrackFingerprints(
      {},
      deps({
        fingerprint: async () => {
          call += 1;
          return call === 1
            ? { status: 'failed' as const, reason: 'not audio' }
            : { status: 'ok' as const, values: makeFingerprint(), durationSec: 210 };
        },
      }),
    );

    expect(stats.failed).toBe(1);
    expect(stats.indexed).toBe(1);
    expect(await readFingerprint(good)).toBeDefined();
  });

  /**
   * The failure mode Postgres introduced and Mongo could not have.
   *
   * `track_fingerprints.track_id` is a foreign key, so a track deleted between
   * this page's `SELECT` and its `INSERT` raises `23503` where Mongo silently
   * stored an orphan row. It is counted apart from `failed` because there is
   * nothing wrong and nothing to retry — telling an operator to investigate
   * audio that no longer exists would be worse than saying nothing.
   *
   * The delete is triggered from inside the fingerprint step, which is exactly
   * the window the real race occupies: the row was read, the audio is being
   * processed, and a takedown lands.
   */
  it('counts a track deleted mid-run as vanished, not as a failure', async () => {
    const artistId = await makeArtist();
    const doomed = await makeTrack(artistId, playable());

    const stats = await backfillTrackFingerprints(
      {},
      deps({
        fingerprint: async () => {
          await getDb().delete(tracks).where(eq(tracks.id, doomed));
          return { status: 'ok' as const, values: makeFingerprint(), durationSec: 210 };
        },
      }),
    );

    expect(stats.vanished).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.indexed).toBe(0);
  });
});

// ── The starvation it closes ─────────────────────────────────────────────────

interface StorageSpy extends LockerPurgeDeps {
  deletedKeys: string[];
  deletedPrefixes: string[];
  notices: LockerRemovalNotice[];
}

function makeStorageSpy(): StorageSpy {
  const spy: StorageSpy = {
    deletedKeys: [],
    deletedPrefixes: [],
    notices: [],
    deleteObject: async (key: string) => {
      spy.deletedKeys.push(key);
    },
    deletePrefix: async (prefix: string) => {
      spy.deletedPrefixes.push(prefix);
      return 3;
    },
    notifyRemoval: async (notice) => {
      spy.notices.push(notice);
    },
  };
  return spy;
}

/** A locker file that only the ACOUSTIC leg can find: different bytes, no link. */
async function makeReencode(fingerprint: number[]): Promise<string> {
  const id = new mongoose.Types.ObjectId();
  await UserUploadModel.create({
    _id: id,
    ownerOxyUserId: 'user-r',
    title: 'A re-encode',
    duration: 210,
    sizeBytes: 5_000_000,
    sha256: 'a-completely-different-hash',
    status: 'ready',
    fingerprint,
    fingerprintDurationSec: 211,
    audioSource: { key: `audio/user-r/${id.toString()}.mp3`, format: 'mp3' },
  });
  return id.toString();
}

/**
 * The reason this script was pulled out of Task 19, and why it went first.
 *
 * The takedown purge reads `track_fingerprints` and this script is the only
 * thing that fills it for the existing catalogue. Before it runs, a takedown of
 * a work a rightsholder identified compares HASHES ONLY — so a re-encode of that
 * recording survives in every locker holding one, and the purge reports success.
 */
describe('backfillTrackFingerprints — the starvation it closes', () => {
  it('a re-encode survives a takedown before the backfill and is purged after it', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId, playable());
    const reencode = await makeReencode(perturb(makeFingerprint(), 0.02));

    // ── Before: the acoustic leg cannot run at all ──
    const before = await purgeLockerCopiesOfTrack(trackId, makeStorageSpy());

    expect(before.acousticMatchingAvailable).toBe(false);
    expect(before.uploadsDeleted).toBe(0);
    // The confident negative: a clean-looking purge that missed the copy.
    expect(await UserUploadModel.findById(reencode).lean()).not.toBeNull();

    // ── The backfill ──
    const stats = await backfillTrackFingerprints({}, deps());
    expect(stats.indexed).toBe(1);

    // ── After: the same takedown now finds the re-encode ──
    const after = await purgeLockerCopiesOfTrack(trackId, makeStorageSpy());

    expect(after.acousticMatchingAvailable).toBe(true);
    expect(after.uploadsDeleted).toBe(1);
    expect(await UserUploadModel.findById(reencode).lean()).toBeNull();
  });

  it('does not start deleting unrelated music once the table is loaded', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId, playable());
    // Same length, entirely different audio — the case a duration-bucket match
    // would wrongly sweep up if the comparator stopped discriminating.
    const otherMusic = await makeReencode(makeFingerprint(0xbeef));

    await backfillTrackFingerprints({}, deps());
    const result = await purgeLockerCopiesOfTrack(trackId, makeStorageSpy());

    expect(result.acousticMatchingAvailable).toBe(true);
    expect(result.uploadsDeleted).toBe(0);
    expect(await UserUploadModel.findById(otherMusic).lean()).not.toBeNull();
  });
});
