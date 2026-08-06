/**
 * `playableTrackFilter()` and `isPlayableTrack()` must agree on every row.
 *
 * They are two artefacts on purpose — listing is a database query, playback is
 * an in-memory check on an already-loaded row — and Syra's own rule is that any
 * field which hides a track from one must hide it from the other. A row the
 * query includes and the predicate refuses is a takedown that stays listed and
 * searchable and then fails at play.
 *
 * Until now that agreement was maintained by discipline and asserted in a
 * comment. This exercises it against REAL ROWS: every combination of the two
 * fields either implementation reads, inserted through the raw driver rather
 * than the model, because Mongoose's `default: true` / `default: false` would
 * otherwise make the ABSENT shape impossible to construct — and the absent
 * shape is the only one on which the two implementations behave differently.
 * A fixture set built with `TrackModel.create` cannot tell them apart at all.
 *
 * ## The asymmetry this file pins down, and why it is not asserted as agreement
 *
 * With `isAvailable` absent, the query excludes the row (`isAvailable: true`
 * does not match a missing key) and the predicate accepts it
 * (`isAvailable !== false`). Measured, not reasoned: the strict-equality form
 * of the first test below fails on exactly two of the nine shapes.
 *
 * That direction is the safe one — the query is STRICTER than the predicate, so
 * nothing unplayable is ever listed — and it is unreachable through this
 * codebase today: no path writes a track through the raw collection and none
 * `$unset`s `isAvailable`, so every stored track carries the Mongoose default.
 * The Postgres port removes the shape entirely (`is_available` is `NOT NULL`),
 * at which point the second test's four combinations are the whole space.
 *
 * So the guard here is the property that survives both implementations and
 * matters in the failing direction: **nothing is listed that playback would
 * refuse.**
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { connect, clear, disconnect } from '../test/mongo';
import { TrackModel } from '../models/Track';
import { isPlayableTrack, playableTrackFilter, type PlayableTrackShape } from './catalogVisibility';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

/**
 * The three states a boolean field can be in on a stored document. `undefined`
 * means the key is absent entirely — what a document written before the field
 * existed looks like.
 */
const STATES = [true, false, undefined] as const;

interface Shape {
  readonly title: string;
  readonly isAvailable?: boolean;
  readonly copyrightRemoved?: boolean;
}

function shape(isAvailable?: boolean, copyrightRemoved?: boolean): Shape {
  return {
    title: `available=${String(isAvailable)},removed=${String(copyrightRemoved)}`,
    ...(isAvailable === undefined ? {} : { isAvailable }),
    ...(copyrightRemoved === undefined ? {} : { copyrightRemoved }),
  };
}

/** All nine combinations, including the two only a raw write can produce. */
function everyShape(): Shape[] {
  return STATES.flatMap((isAvailable) =>
    STATES.map((copyrightRemoved) => shape(isAvailable, copyrightRemoved)),
  );
}

/** The four an application write path can actually produce (both defaults apply). */
function writtenShapes(): Shape[] {
  return [true, false].flatMap((isAvailable) =>
    [true, false].map((copyrightRemoved) => shape(isAvailable, copyrightRemoved)),
  );
}

/**
 * Insert through the raw collection, NOT the model: Mongoose applies
 * `isAvailable`'s `default: true` and `copyrightRemoved`'s `default: false` on
 * every model write, so only the driver can store a document with either key
 * missing.
 */
async function insert(shapes: readonly Shape[]): Promise<void> {
  await TrackModel.collection.insertMany(
    shapes.map((entry) => ({
      title: entry.title,
      artistId: 'artist-1',
      artistName: 'Artist',
      duration: 180,
      source: 'upload',
      status: 'ready',
      ...(entry.isAvailable === undefined ? {} : { isAvailable: entry.isAvailable }),
      ...(entry.copyrightRemoved === undefined ? {} : { copyrightRemoved: entry.copyrightRemoved }),
    })),
  );
}

/** Titles the catalog query returns. */
async function listed(): Promise<string[]> {
  const rows = await TrackModel.find(playableTrackFilter({})).select({ title: 1 }).lean();
  return rows.map((row) => row.title).sort();
}

/** Titles the in-memory predicate accepts, read back from the same rows. */
async function accepted(): Promise<string[]> {
  const rows = await TrackModel.find({}).lean();
  return rows
    .filter((row) => isPlayableTrack(row as PlayableTrackShape))
    .map((row) => row.title)
    .sort();
}

describe('playableTrackFilter / isPlayableTrack agreement', () => {
  it('never lists a row the in-memory predicate would refuse', async () => {
    await insert(everyShape());

    const listedTitles = await listed();
    const acceptedTitles = new Set(await accepted());

    const listedButUnplayable = listedTitles.filter((title) => !acceptedTitles.has(title));
    expect(listedButUnplayable).toEqual([]);
  });

  it('agrees exactly on every shape an application write can produce', async () => {
    await insert(writtenShapes());

    expect(await listed()).toEqual(await accepted());
  });

  it('is not vacuous — the fixture set spans both sides of the predicate', async () => {
    await insert(everyShape());

    const total = await TrackModel.countDocuments({});
    const playable = await TrackModel.countDocuments(playableTrackFilter({}));

    expect(total).toBe(9);
    expect(playable).toBeGreaterThan(0);
    expect(playable).toBeLessThan(total);
  });
});
