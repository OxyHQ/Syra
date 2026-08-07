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
import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import mongoose from 'mongoose';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, trackFingerprints, tracks } from '../db/schema/catalog';
import { indexTrackAcoustically } from '../db/catalog/fingerprints';
import { userUploads } from '../db/schema/creators';
import { logger } from '../utils/logger';
import {
  purgeLockerCopiesOfTrack,
  type LockerPurgeDeps,
  type LockerRemovalNotice,
} from '../services/compliance/takedown';
import { backfillTrackFingerprints, type BackfillDeps } from './backfillTrackFingerprints';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

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
 * Capture `logger.warn` for the duration of `run`, keeping the meta OBJECT.
 *
 * Deliberately not a JSON string. `message` and `stack` are non-enumerable on an
 * `Error`, so `JSON.stringify({ err })` yields `{}` and an assertion that the
 * reason survived would fail against code that is perfectly correct — the first
 * draft of the staging test did exactly that. Pino serializes the error properly
 * in production (verified: the emitted line carries `message`, `code`, `path`
 * and `syscall`), so the object is the honest thing to assert against.
 *
 * Reassign-and-restore is the convention `crowdsourceWebhook.mount.test.ts` uses.
 */
async function captureWarnings(
  run: () => Promise<void>,
): Promise<Array<{ message: string; meta: unknown }>> {
  const captured: Array<{ message: string; meta: unknown }> = [];
  const originalWarn = logger.warn;
  logger.warn = ((message: string, meta?: unknown) => {
    captured.push({ message, meta });
  }) as typeof logger.warn;
  try {
    await run();
  } finally {
    logger.warn = originalWarn;
  }
  return captured;
}

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
  /**
   * A driver error must not be logged whole.
   *
   * postgres.js attaches the failing statement and its bound parameters, so
   * `logger.warn(…, { err })` publishes the entire fingerprint — measured at
   * FIVE copies of every value across `message`, `stack` and a structured
   * `params` array. At ~1600 int32s per track on a catalogue-wide run that is a
   * log-volume problem and a data-in-logs problem at once, and nothing like it
   * existed before the port: a Mongoose error carried no statement.
   *
   * The trigger is a real bug rather than a contrived one. `fpcalc` prints
   * UNSIGNED uint32 and `fingerprint.ts` folds with `| 0`; without that fold the
   * value below is exactly what arrives, and `integer[]` refuses it with
   * `22003`. So this pins the redaction on the error a plausible regression
   * would actually produce.
   */
  it('never logs the bound parameters when the driver refuses the write', async () => {
    const artistId = await makeArtist();
    await makeTrack(artistId, playable());

    const captured = await captureWarnings(async () => {
      const stats = await backfillTrackFingerprints(
        {},
        deps({
          fingerprint: async () => ({
            status: 'ok' as const,
            // Above 2^31-1: what fpcalc emits when the `| 0` fold is skipped.
            values: [3849189879, 222222],
            durationSec: 210,
          }),
        }),
      );
      expect(stats.failed).toBe(1);
    });

    expect(captured).toHaveLength(1);
    const [warning] = captured;
    // Not vacuous: something WAS logged, and it names the right subsystem.
    expect(warning?.message).toContain('the database refused the fingerprint');
    // The structural facts worth reading survive.
    expect(warning?.meta).toEqual({
      driver: { code: '22003', constraint: undefined, kind: 'Error' },
    });

    /**
     * And nothing else does. Asserted over the whole meta INCLUDING
     * non-enumerable properties, because `query`/`params` are enumerable on
     * drizzle's error while `message`/`stack` are not — a plain
     * `JSON.stringify` would silently drop half of what it is meant to police.
     */
    const everything = JSON.stringify(warning?.meta, (_key, value: unknown) =>
      value instanceof Error
        ? Object.fromEntries(
            Object.getOwnPropertyNames(value).map((k) => [k, Reflect.get(value, k)]),
          )
        : value,
    );
    expect(everything).not.toContain('3849189879');
    expect(everything).not.toContain('222222');
    expect(everything).not.toContain('insert into');
  });

  /**
   * The other side of that branch, and the one that decides where an operator
   * looks first.
   *
   * A STAGING failure must name the filesystem, keep its reason, and not be
   * dressed up as a database failure. The archetype is `ENOSPC` on a
   * catalogue-wide run — `/tmp` filling is a documented recurring condition
   * here — and the earlier `sqlStateOf(err) !== undefined` predicate reported
   * exactly this case as "the database refused the fingerprint" with the real
   * reason discarded. A missing reason costs an hour; a wrong one costs a night.
   *
   * The error is a REAL `ENOENT` raised by the same `pipeline()` into a
   * `createWriteStream` the script runs, not a synthesised object.
   */
  it('reports a staging failure as the filesystem, with its reason intact', async () => {
    const artistId = await makeArtist();
    await makeTrack(artistId, playable());

    const captured = await captureWarnings(async () => {
      const stats = await backfillTrackFingerprints(
        {},
        deps({
          streamAudio: async () => {
            await pipeline(
              Readable.from([Buffer.from('x')]),
              fs.createWriteStream('/nonexistent-dir-19a/staged.mp3'),
            );
            throw new Error('unreachable — the pipeline above always fails');
          },
        }),
      );
      expect(stats.failed).toBe(1);
    });

    expect(captured).toHaveLength(1);
    const [warning] = captured;
    // Named as the filesystem, NOT dressed up as a database failure.
    expect(warning?.message).toContain('could not read audio');
    expect(warning?.message).not.toContain('the database refused');

    // And the reason survives — the whole diagnosis for a staging failure.
    const err = (warning?.meta as { err?: unknown } | undefined)?.err;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('ENOENT');
    // Not the redacted shape: `describeDriverError` would have discarded that.
    expect(warning?.meta).not.toHaveProperty('driver');
  });

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
  // Minted here because the S3 key below is composed from it.
  const id = uuidv7();
  await getDb().insert(userUploads).values({
    id,
    ownerOxyUserId: 'user-r',
    title: 'A re-encode',
    duration: 210,
    sizeBytes: 5_000_000,
    sha256: 'a-completely-different-hash',
    status: 'ready',
    fingerprint,
    fingerprintDurationSec: 211,
    audioSourceKey: `audio/user-r/${id}.mp3`,
    audioSourceFormat: 'mp3',
  });
  return id;
}

/** A locker row, read back directly rather than through a production helper. */
async function readUpload(uploadId: string) {
  const [row] = await getDb().select().from(userUploads).where(eq(userUploads.id, uploadId));
  return row;
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
    expect(await readUpload(reencode)).toBeDefined();

    // ── The backfill ──
    const stats = await backfillTrackFingerprints({}, deps());
    expect(stats.indexed).toBe(1);

    // ── After: the same takedown now finds the re-encode ──
    const after = await purgeLockerCopiesOfTrack(trackId, makeStorageSpy());

    expect(after.acousticMatchingAvailable).toBe(true);
    expect(after.uploadsDeleted).toBe(1);
    expect(await readUpload(reencode)).toBeUndefined();
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
    expect(await readUpload(otherMusic)).toBeDefined();
  });
});
