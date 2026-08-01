import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../test/mongo';
import { TrackModel } from './Track';

beforeAll(connect);
beforeEach(async () => {
  await TrackModel.createIndexes();
});
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

describe('Track content hash (dedup tier 1)', () => {
  const sha256 = 'a'.repeat(64);


    /**
     * COVERAGE BOUNDARY, stated because the old name overpromised it.
     *
     * `select: false` is a QUERY PROJECTION. `aggregate()` ignores it entirely
     * and returns the whole document, so this proves the `find`/`findOne` path
     * ONLY. Any aggregation pipeline that reads this collection must exclude the
     * field explicitly with `$project`, and any serializer funnel must strip it.
     * Treat `select: false` as a bytes-on-the-wire optimisation, never as access
     * control.
     */
  it('is NOT returned by find()/findOne() — see the note on aggregate()', async () => {
    const created = await TrackModel.create(track({ sha256 }));

    // Server-only by construction: a serializer that spreads a document cannot
    // leak a field the query never fetched.
    const found = await TrackModel.findById(created._id).lean();
    expect(found?.sha256).toBeUndefined();
  });

  it('IS stored, matchable by query, and readable when asked for explicitly', async () => {
    // The vacuity floor for the test above — and the actual tier-1 lookup: the
    // same bytes already in the catalog must resolve in ONE indexed query.
    const created = await TrackModel.create(track({ sha256 }));

    const matched = await TrackModel.findOne({ sha256 }).lean();
    expect(matched?._id.toString()).toBe(created._id.toString());

    const withHash = await TrackModel.findById(created._id).select('+sha256').lean();
    expect(withHash?.sha256).toBe(sha256);
  });

  it('does NOT reject two tracks sharing a hash', async () => {
    // Deliberately not unique: two catalog tracks with the same bytes is a data
    // error worth SEEING, and an E11000 mid-ingest would turn a reportable
    // anomaly into a failed upload.
    await TrackModel.create(track({ sha256 }));
    await TrackModel.create(track({ title: 'Same bytes', sha256 }));

    expect(await TrackModel.countDocuments({ sha256 })).toBe(2);
  });
});
