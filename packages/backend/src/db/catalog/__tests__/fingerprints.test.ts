/**
 * `indexTrackAcoustically` — the one writer of `track_fingerprints`.
 *
 * WHY THIS FILE EXISTS. These five behaviours were covered, but against the
 * WRONG implementation. Two functions of this name existed: the live drizzle one
 * here, and a Mongoose twin in `models/TrackFingerprint.ts` whose only importer
 * was its own colocated test. That test's describe block called itself "the one
 * writer" while all three real producers — `services/ingest/ingestTrack.ts`,
 * `scripts/backfillTrackFingerprints.ts` and `controllers/uploads.controller.ts`
 * — had moved to this module. It passed, it read like meaningful coverage, and
 * it exercised code nothing called.
 *
 * Task 19a deleted the twin and moved its assertions here, so the refusals below
 * guard the function that actually runs. `backfillTrackFingerprints.test.ts`
 * imports this module too, but only to SEED a row — it asserts none of this.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { catalogEntities, trackFingerprints, tracks } from '../../schema/catalog';
import { hasTrackFingerprint, indexTrackAcoustically } from '../fingerprints';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const VALUES = [1, -445777417, 3, 4, 5];

/**
 * Real parent rows. `track_fingerprints.track_id` is a real
 * `.references(() => tracks.id)`, which the Mongoose collection had no
 * equivalent of — the twin's fixtures were bare strings naming nothing.
 */
const TRACK_IDS = ['track-1', 'track-empty', 'track-bad', 'track-signed'] as const;

beforeEach(async () => {
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({ name: 'Fingerprint Fixture Artist', type: 'artist', source: 'upload' })
    .returning({ id: catalogEntities.id });

  await getDb().insert(tracks).values(
    TRACK_IDS.map((id) => ({
      id,
      title: `Fixture ${id}`,
      artistId: artist.id,
      artistName: 'Fingerprint Fixture Artist',
      duration: 180,
      source: 'upload' as const,
    }))
  );
});

function rowsFor(trackId: string) {
  return getDb().select().from(trackFingerprints).where(eq(trackFingerprints.trackId, trackId));
}

describe('indexTrackAcoustically — the one writer', () => {
  it('writes a row', async () => {
    expect(await indexTrackAcoustically('track-1', { values: VALUES, durationSec: 212 })).toBe(true);

    const [row] = await rowsFor('track-1');
    expect(row.fingerprint).toEqual(VALUES);
    expect(row.fingerprintDurationSec).toBe(212);
  });

  it('REPLACES rather than failing when the track is already indexed', async () => {
    // `track_id` is unique, so a plain insert would throw on a re-run. Upserting
    // is what makes the backfill resumable and safe to run twice.
    await indexTrackAcoustically('track-1', { values: VALUES, durationSec: 212 });
    await indexTrackAcoustically('track-1', { values: [9, 9, 9], durationSec: 400 });

    const rows = await rowsFor('track-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].fingerprint).toEqual([9, 9, 9]);
    expect(rows[0].fingerprintDurationSec).toBe(400);
  });

  it('REFUSES an empty fingerprint and writes nothing', async () => {
    // An empty row still matches the duration bucket, so the matcher returns it
    // as a candidate, compares against nothing, and can never match — it just
    // re-examines it on every upload forever. No row is the honest state.
    expect(await indexTrackAcoustically('track-empty', { values: [], durationSec: 212 })).toBe(false);
    expect(await rowsFor('track-empty')).toHaveLength(0);
  });

  it('REFUSES a nonsensical duration, which is the bucket key', async () => {
    // The duration IS the candidate bucket. A zero or NaN duration puts the row
    // in a bucket nothing will ever range-scan into, so it is unreachable
    // storage that still costs a write.
    for (const durationSec of [0, -5, Number.NaN]) {
      expect(await indexTrackAcoustically('track-bad', { values: VALUES, durationSec })).toBe(false);
    }
    expect(await rowsFor('track-bad')).toHaveLength(0);
  });

  it('preserves signed int32 values exactly', async () => {
    // fpcalc prints UNSIGNED, the comparator reads the bit pattern, and the
    // column stores signed `integer`. A silent coercion anywhere in that chain
    // changes every bit-error-rate comparison this table exists to serve.
    await indexTrackAcoustically('track-signed', {
      values: [-445777417, 2147483647, -2147483648],
      durationSec: 100,
    });

    const [row] = await rowsFor('track-signed');
    expect(row.fingerprint).toEqual([-445777417, 2147483647, -2147483648]);
  });
});

describe('hasTrackFingerprint', () => {
  it('answers for an indexed track and an un-indexed one', async () => {
    await indexTrackAcoustically('track-1', { values: VALUES, durationSec: 212 });

    expect(await hasTrackFingerprint('track-1')).toBe(true);
    expect(await hasTrackFingerprint('track-empty')).toBe(false);
  });
});
