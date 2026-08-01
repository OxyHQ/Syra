import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../test/mongo';
import { backfillTrackFingerprints } from './backfillTrackFingerprints';
import { TrackModel } from '../models/Track';
import { TrackFingerprintModel, indexTrackAcoustically } from '../models/TrackFingerprint';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

function track(overrides: Record<string, unknown> = {}) {
  return {
    title: 'A Recording',
    artistId: 'artist-1',
    artistName: 'An Artist',
    duration: 210,
    isAvailable: true,
    source: 'upload' as const,
    ...overrides,
  };
}

/**
 * The "nothing to do" paths, which is what a first production dry run actually
 * hits. A script that divides by zero or prints a confusing summary when the
 * catalogue is empty is discovered during a deploy otherwise — and a deploy is
 * the worst place to learn that a report cannot be trusted.
 *
 * These cases never reach S3 or `fpcalc`: every track here is filtered out
 * before the audio read, which is exactly why they are the safe ones to pin.
 */
describe('backfillTrackFingerprints — nothing to do', () => {
  it('reports all zeros against an EMPTY catalogue, without throwing', async () => {
    const stats = await backfillTrackFingerprints({ dryRun: true });

    expect(stats).toEqual({ scanned: 0, indexed: 0, skipped: 0, failed: 0, rejected: 0 });
  });

  it('ignores tracks that have no audio to fingerprint', async () => {
    // A track still processing, or one whose source was dropped, has nothing to
    // read. It must not be counted as failed — that would make a healthy run
    // look broken and hide the tracks that genuinely could not be read.
    await TrackModel.create(track({ title: 'Still processing', status: 'processing' }));
    await TrackModel.create(track({ title: 'No audio source' }));

    const stats = await backfillTrackFingerprints({ dryRun: true });

    expect(stats.scanned).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it('skips what is already indexed, which is what makes a resumed run cheap', async () => {
    const done = await TrackModel.create(
      track({ audioSource: { url: '/api/audio/x', format: 'mp3' } }),
    );
    await indexTrackAcoustically(done._id.toString(), { values: [1, 2, 3], durationSec: 210 });

    const stats = await backfillTrackFingerprints({ dryRun: true });

    // Counted as scanned AND skipped — never re-read from S3.
    expect(stats.scanned).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.indexed).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it('a dry run writes nothing', async () => {
    await TrackModel.create(track({ audioSource: { url: '/api/audio/y', format: 'mp3' } }));

    await backfillTrackFingerprints({ dryRun: true, limit: 0 });

    expect(await TrackFingerprintModel.countDocuments({})).toBe(0);
  });

  it('honours --limit 0 as "do nothing" rather than "no limit"', async () => {
    // `--limit 0` is what somebody types to check the wiring. Reading it as
    // falsy-therefore-unlimited would start a full catalogue pass instead.
    await TrackModel.create(track({ audioSource: { url: '/api/audio/z', format: 'mp3' } }));

    const stats = await backfillTrackFingerprints({ dryRun: true, limit: 0 });

    expect(stats.scanned).toBe(0);
  });
});
