import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../test/mongo';
import { TrackFingerprintModel, indexTrackAcoustically } from './TrackFingerprint';

beforeAll(connect);
beforeEach(async () => {
  await TrackFingerprintModel.createIndexes();
});
afterEach(clear);
afterAll(disconnect);

const VALUES = [1, -445777417, 3, 4, 5];

describe('indexTrackAcoustically — the one writer', () => {
  it('writes a row', async () => {
    expect(await indexTrackAcoustically('track-1', { values: VALUES, durationSec: 212 })).toBe(true);

    const row = await TrackFingerprintModel.findOne({ trackId: 'track-1' }).lean();
    expect(row?.fingerprint).toEqual(VALUES);
    expect(row?.fingerprintDurationSec).toBe(212);
  });

  it('REPLACES rather than failing when the track is already indexed', async () => {
    // `trackId` is unique, so a plain insert would throw on a re-run. Upserting
    // is what makes the backfill resumable and safe to run twice.
    await indexTrackAcoustically('track-1', { values: VALUES, durationSec: 212 });
    await indexTrackAcoustically('track-1', { values: [9, 9, 9], durationSec: 400 });

    expect(await TrackFingerprintModel.countDocuments({ trackId: 'track-1' })).toBe(1);
    const row = await TrackFingerprintModel.findOne({ trackId: 'track-1' }).lean();
    expect(row?.fingerprint).toEqual([9, 9, 9]);
    expect(row?.fingerprintDurationSec).toBe(400);
  });

  it('REFUSES an empty fingerprint and writes nothing', async () => {
    // An empty row still matches the duration bucket, so the matcher returns it
    // as a candidate, compares against nothing, and can never match — it just
    // re-examines it on every upload forever. No row is the honest state.
    expect(await indexTrackAcoustically('track-empty', { values: [], durationSec: 212 })).toBe(false);
    expect(await TrackFingerprintModel.countDocuments({ trackId: 'track-empty' })).toBe(0);
  });

  it('REFUSES a nonsensical duration, which is the bucket key', async () => {
    // The duration IS the candidate bucket. A zero or NaN duration puts the row
    // in a bucket nothing will ever range-scan into, so it is unreachable
    // storage that still costs a write.
    for (const durationSec of [0, -5, Number.NaN]) {
      expect(await indexTrackAcoustically('track-bad', { values: VALUES, durationSec })).toBe(false);
    }
    expect(await TrackFingerprintModel.countDocuments({ trackId: 'track-bad' })).toBe(0);
  });

  it('preserves signed int32 values exactly', async () => {
    // fpcalc prints UNSIGNED, the comparator reads the bit pattern, and the
    // schema stores signed. A silent coercion anywhere in that chain changes
    // every bit-error-rate comparison this collection exists to serve.
    await indexTrackAcoustically('track-signed', { values: [-445777417, 2147483647, -2147483648], durationSec: 100 });

    const row = await TrackFingerprintModel.findOne({ trackId: 'track-signed' }).lean();
    expect(row?.fingerprint).toEqual([-445777417, 2147483647, -2147483648]);
  });
});
