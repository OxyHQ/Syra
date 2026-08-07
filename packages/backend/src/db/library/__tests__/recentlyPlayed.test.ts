/**
 * The per-user play log, against real rows.
 *
 * Each of the three operations replaces a Mongo shape whose translation is not
 * mechanical, and each fixture below is chosen to sit on the side of the
 * distinction that tells the correct translation from the plausible one:
 *
 *  - the read collapses to the most recent play PER TRACK, so the fixture has a
 *    track played twice with another track's play in between — a collapse that
 *    kept the FIRST row instead of the newest would return the same set in a
 *    different order, and a set-only assertion could not see it;
 *  - the dedup update touched exactly ONE document under `findOneAndUpdate`,
 *    so the fixture has two rows inside the window;
 *  - the prune deletes with `<=` the cutoff, so the fixture has rows sharing
 *    the cutoff instant.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { catalogEntities, tracks } from '../../schema/catalog';
import { recentlyPlayed } from '../../schema/library';
import {
  findRecentTrackIds,
  prunePlayHistory,
  recordPlayEvent,
  touchRecentPlay,
} from '../recentlyPlayed';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const USER = 'oxy-listener';
const OTHER = 'oxy-other-listener';

async function makeTrack(): Promise<string> {
  const artistId = uuidv7();
  await getDb()
    .insert(catalogEntities)
    .values({ id: artistId, type: 'artist', name: 'Artist', nameKey: artistId, source: 'upload' });

  const id = uuidv7();
  await getDb()
    .insert(tracks)
    .values({ id, title: 'Track', artistId, artistName: 'Artist', duration: 200, source: 'upload' });
  return id;
}

function at(iso: string): Date {
  return new Date(iso);
}

async function playedAtFor(oxyUserId: string): Promise<Date[]> {
  const rows = await getDb()
    .select({ playedAt: recentlyPlayed.playedAt })
    .from(recentlyPlayed)
    .where(eq(recentlyPlayed.oxyUserId, oxyUserId))
    .orderBy(asc(recentlyPlayed.playedAt));
  return rows.map((row) => row.playedAt);
}

describe('findRecentTrackIds collapses plays to the most recent per track', () => {
  it('keeps the NEWEST play of a repeated track, not the first', async () => {
    const [a, b] = [await makeTrack(), await makeTrack()];
    // `a` played first, then `b`, then `a` again. A collapse that kept the
    // FIRST play per track would answer `[b, a]`; the correct one answers
    // `[a, b]`. Same set, different order — which is why the assertion is on
    // the array and not on membership.
    await getDb().insert(recentlyPlayed).values([
      { oxyUserId: USER, trackId: a, playedAt: at('2026-01-01T10:00:00Z') },
      { oxyUserId: USER, trackId: b, playedAt: at('2026-01-01T11:00:00Z') },
      { oxyUserId: USER, trackId: a, playedAt: at('2026-01-01T12:00:00Z') },
    ]);

    expect(await findRecentTrackIds(USER, 20)).toEqual([a, b]);
  });

  it('answers only this user\'s plays', async () => {
    const [mine, theirs] = [await makeTrack(), await makeTrack()];
    await getDb().insert(recentlyPlayed).values([
      { oxyUserId: USER, trackId: mine, playedAt: at('2026-01-01T10:00:00Z') },
      { oxyUserId: OTHER, trackId: theirs, playedAt: at('2026-01-01T11:00:00Z') },
    ]);

    expect(await findRecentTrackIds(USER, 20)).toEqual([mine]);
  });

  it('the limit counts DISTINCT tracks, not play rows', async () => {
    // Three rows, two tracks, limit 2. A limit applied before the collapse
    // would answer one track.
    const [a, b] = [await makeTrack(), await makeTrack()];
    await getDb().insert(recentlyPlayed).values([
      { oxyUserId: USER, trackId: a, playedAt: at('2026-01-01T10:00:00Z') },
      { oxyUserId: USER, trackId: a, playedAt: at('2026-01-01T11:00:00Z') },
      { oxyUserId: USER, trackId: b, playedAt: at('2026-01-01T09:00:00Z') },
    ]);

    expect(await findRecentTrackIds(USER, 2)).toEqual([a, b]);
  });

  it('is empty for a listener who has played nothing', async () => {
    expect(await findRecentTrackIds(USER, 20)).toEqual([]);
  });
});

describe('touchRecentPlay refreshes at most one row', () => {
  it('refreshes the most recent qualifying row and leaves the other alone', async () => {
    const trackId = await makeTrack();
    // TWO rows inside the window. `findOneAndUpdate` updated exactly one, and a
    // bare `UPDATE … WHERE played_at >= …` would update both — which no fixture
    // with a single row in the window could tell apart.
    await getDb().insert(recentlyPlayed).values([
      { oxyUserId: USER, trackId, playedAt: at('2026-01-01T12:00:00Z') },
      { oxyUserId: USER, trackId, playedAt: at('2026-01-01T12:00:10Z') },
    ]);

    const now = at('2026-01-01T12:00:20Z');
    const since = at('2026-01-01T12:00:00Z');
    expect(await touchRecentPlay(USER, trackId, since, now)).toBe(true);

    expect((await playedAtFor(USER)).map((date) => date.toISOString())).toEqual([
      '2026-01-01T12:00:00.000Z',
      '2026-01-01T12:00:20.000Z',
    ]);
  });

  it('answers false when the last play is older than the window', async () => {
    const trackId = await makeTrack();
    await getDb()
      .insert(recentlyPlayed)
      .values({ oxyUserId: USER, trackId, playedAt: at('2026-01-01T11:00:00Z') });

    const refreshed = await touchRecentPlay(
      USER,
      trackId,
      at('2026-01-01T12:00:00Z'),
      at('2026-01-01T12:00:30Z')
    );

    expect(refreshed).toBe(false);
    expect((await playedAtFor(USER)).map((date) => date.toISOString())).toEqual([
      '2026-01-01T11:00:00.000Z',
    ]);
  });

  it('never refreshes another listener\'s play of the same track', async () => {
    const trackId = await makeTrack();
    await getDb()
      .insert(recentlyPlayed)
      .values({ oxyUserId: OTHER, trackId, playedAt: at('2026-01-01T12:00:10Z') });

    const refreshed = await touchRecentPlay(
      USER,
      trackId,
      at('2026-01-01T12:00:00Z'),
      at('2026-01-01T12:00:20Z')
    );

    expect(refreshed).toBe(false);
    expect((await playedAtFor(OTHER)).map((date) => date.toISOString())).toEqual([
      '2026-01-01T12:00:10.000Z',
    ]);
  });
});

describe('prunePlayHistory caps the log per listener', () => {
  async function seedPlays(oxyUserId: string, count: number, trackId: string): Promise<void> {
    await getDb()
      .insert(recentlyPlayed)
      .values(
        Array.from({ length: count }, (_, index) => ({
          oxyUserId,
          trackId,
          playedAt: new Date(Date.UTC(2026, 0, 1) + index * 1000),
        }))
      );
  }

  it('keeps exactly the retention window and drops what is older', async () => {
    const trackId = await makeTrack();
    await seedPlays(USER, 12, trackId);

    await prunePlayHistory(USER, 10);

    expect((await playedAtFor(USER)).length).toBe(10);
  });

  it('does nothing when the listener is inside the window', async () => {
    const trackId = await makeTrack();
    await seedPlays(USER, 5, trackId);

    await prunePlayHistory(USER, 10);

    expect((await playedAtFor(USER)).length).toBe(5);
  });

  /**
   * `<=` the cutoff, not `<`, so rows sharing the cutoff instant go together.
   * Mongo's `$lte` behaved this way and a batch of plays written in the same
   * millisecond should not end up half retained.
   */
  it('drops rows that share the cutoff instant', async () => {
    const trackId = await makeTrack();
    const tied = at('2026-01-01T00:00:00Z');
    await getDb().insert(recentlyPlayed).values([
      { oxyUserId: USER, trackId, playedAt: tied },
      { oxyUserId: USER, trackId, playedAt: tied },
      { oxyUserId: USER, trackId, playedAt: at('2026-01-01T00:00:01Z') },
      { oxyUserId: USER, trackId, playedAt: at('2026-01-01T00:00:02Z') },
    ]);

    // Retention 3 → the cutoff row is the oldest, and its twin shares the
    // instant, so BOTH go and two rows are left rather than three.
    await prunePlayHistory(USER, 3);

    expect((await playedAtFor(USER)).map((date) => date.toISOString())).toEqual([
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
    ]);
  });

  it('never prunes another listener\'s log', async () => {
    const trackId = await makeTrack();
    await seedPlays(USER, 12, trackId);
    await seedPlays(OTHER, 12, trackId);

    await prunePlayHistory(USER, 10);

    expect((await playedAtFor(OTHER)).length).toBe(12);
  });
});

describe('recordPlayEvent', () => {
  it('refuses a track that does not exist, so the controller can answer 404', async () => {
    // `recently_played.track_id` is a real foreign key. The Mongo version stored
    // the string, which is how a play log accumulated ids naming nothing.
    await expect(recordPlayEvent(USER, uuidv7(), new Date())).rejects.toThrow();
    expect((await playedAtFor(USER)).length).toBe(0);
  });
});
