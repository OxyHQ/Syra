/**
 * `insertEpisode` and the show counters it maintains.
 *
 * This file exists because of a mutation that SURVIVED. The Task 12 review (M2)
 * found `recordNewEpisode` sitting outside `insertEpisode`'s transaction, and
 * folding it in was a one-line move — but disabling the folded branch
 * (`if (false && options.recordOnShow)`) left every suite green, including the
 * creator-upload route tests that exercise the path end to end. A behaviour
 * moved without a test is a behaviour nobody is holding.
 *
 * The counters are worth holding: only the RSS import path recomputes them from
 * the rows (`episodeStats`), so a Syra-hosted show whose bump is lost drifts
 * permanently, and nothing recomputes it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { episodes, podcasts } from '../../schema/podcasts';
import { episodeStats, insertEpisode } from '../episodes';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

async function makeShow(): Promise<string> {
  const id = uuidv7();
  await getDb().insert(podcasts).values({ id, title: 'A Show', source: 'syra' });
  return id;
}

async function showCounters(
  podcastId: string
): Promise<{ episodeCount: number; lastEpisodeAt: Date | null }> {
  const [row] = await getDb()
    .select({ episodeCount: podcasts.episodeCount, lastEpisodeAt: podcasts.lastEpisodeAt })
    .from(podcasts)
    .where(eq(podcasts.id, podcastId));
  return row ?? { episodeCount: -1, lastEpisodeAt: null };
}

function episodeValues(podcastId: string, title: string, pubDate: Date) {
  return {
    podcastId,
    podcastTitle: 'A Show',
    title,
    guid: uuidv7(),
    pubDate,
    source: 'syra' as const,
  };
}

describe('insertEpisode — recordOnShow', () => {
  it('bumps episode_count and sets last_episode_at in the same write', async () => {
    const showId = await makeShow();
    const pubDate = new Date('2026-03-01T10:00:00.000Z');

    await insertEpisode(episodeValues(showId, 'First', pubDate), {}, { recordOnShow: true });

    const counters = await showCounters(showId);
    expect(counters.episodeCount).toBe(1);
    expect(counters.lastEpisodeAt?.toISOString()).toBe(pubDate.toISOString());
  });

  it('accumulates across uploads rather than overwriting', async () => {
    const showId = await makeShow();
    const first = new Date('2026-03-01T10:00:00.000Z');
    const second = new Date('2026-03-08T10:00:00.000Z');

    await insertEpisode(episodeValues(showId, 'First', first), {}, { recordOnShow: true });
    await insertEpisode(episodeValues(showId, 'Second', second), {}, { recordOnShow: true });

    const counters = await showCounters(showId);
    expect(counters.episodeCount).toBe(2);
    expect(counters.lastEpisodeAt?.toISOString()).toBe(second.toISOString());
  });

  it('leaves the counters ALONE when recordOnShow is not asked for', async () => {
    /**
     * The control. Without it, "the counters are 1 after an insert" could
     * equally mean the bump happens unconditionally — and the flag would be
     * decorative rather than load-bearing.
     */
    const showId = await makeShow();

    await insertEpisode(episodeValues(showId, 'Unrecorded', new Date()));

    const counters = await showCounters(showId);
    expect(counters.episodeCount).toBe(0);
    expect(counters.lastEpisodeAt).toBeNull();
  });

  it('rolls the EPISODE back when the counter bump itself fails', async () => {
    /**
     * The one case where the transaction boundary is observable, and it is
     * observable only because the failure lands AFTER the insert.
     *
     * `episode_count` is `integer`, so a show already at `int4` max overflows
     * on the next `+ 1` — a real, forceable failure of the second statement.
     * Under a rollback the episode must not survive; without one the show would
     * carry an episode it never counted.
     *
     * ## What this does NOT prove, stated so nobody reads it as more
     *
     * Mutating `tx` to `getDb()` here — running the bump on its own connection,
     * which is the defect M2 describes — leaves every test in this file GREEN,
     * including this one. Measured, not assumed. At the current statement order
     * the two are indistinguishable: the bump is last, so an independent commit
     * has nothing after it to be undone by, and a THROWN bump propagates out of
     * the callback and rolls the episode back either way.
     *
     * The `tx` form is kept regardless, because it is the honest expression of
     * "the episode and the show's count of it are one fact" and it stays correct
     * if a statement is ever added after it. But it is defensive rather than
     * currently load-bearing, and a comment claiming a test holds it would be
     * exactly the "comment standing in for a guard" this port keeps finding.
     */
    const showId = await makeShow();
    await getDb()
      .update(podcasts)
      .set({ episodeCount: 2147483647 })
      .where(eq(podcasts.id, showId));

    await expect(
      insertEpisode(episodeValues(showId, 'Overflows', new Date()), {}, { recordOnShow: true })
    ).rejects.toThrow();

    const rows = await getDb()
      .select({ id: episodes.id })
      .from(episodes)
      .where(eq(episodes.podcastId, showId));
    expect(rows).toHaveLength(0);
    expect((await showCounters(showId)).episodeCount).toBe(2147483647);
  });

  it('writes NEITHER the episode nor the counter when the insert fails', async () => {
    /**
     * What putting the bump inside the transaction actually buys, asserted
     * rather than assumed.
     *
     * The first episode succeeds and moves the counter to 1. The second reuses
     * its `guid`, so `episodes_podcast_id_guid_key` rejects it — and the
     * counter must still read 1, not 2.
     *
     * Note this one is about ORDERING, not the transaction: the insert fails
     * before the bump is reached, so the bump never runs. It is still worth
     * holding — a future refactor that bumped first would break it — but see the
     * case above for what the transaction boundary itself is and is not proven
     * to do.
     */
    const showId = await makeShow();
    const shared = { ...episodeValues(showId, 'First', new Date()), guid: 'duplicate-guid' };

    await insertEpisode(shared, {}, { recordOnShow: true });
    await expect(
      insertEpisode({ ...shared, title: 'Clash' }, {}, { recordOnShow: true })
    ).rejects.toThrow();

    expect((await showCounters(showId)).episodeCount).toBe(1);

    const rows = await getDb()
      .select({ id: episodes.id })
      .from(episodes)
      .where(eq(episodes.podcastId, showId));
    expect(rows).toHaveLength(1);
  });
});

describe('episodeStats — the RSS path\'s recompute', () => {
  it('counts the rows and returns the newest pub_date as a Date', async () => {
    const showId = await makeShow();
    const older = new Date('2026-03-01T10:00:00.000Z');
    const newest = new Date('2026-03-08T10:00:00.000Z');
    // Inserted OUT of order, so "newest" cannot be satisfied by insertion order.
    await insertEpisode(episodeValues(showId, 'Newest', newest));
    await insertEpisode(episodeValues(showId, 'Older', older));

    const stats = await episodeStats(showId);
    expect(stats.total).toBe(2);
    /**
     * `instanceof Date` is the assertion, not decoration: this function used to
     * read `max(pub_date)` through `sql<Date | null>`, which returns a driver
     * STRING that the generic asserts away. It typechecked, flowed into a
     * `timestamptz` write, and died inside drizzle's own `mapToDriverValue`.
     */
    expect(stats.latestPubDate).toBeInstanceOf(Date);
    expect(stats.latestPubDate?.toISOString()).toBe(newest.toISOString());
  });

  it('answers zero and undefined for a show with no episodes', async () => {
    const showId = await makeShow();
    expect(await episodeStats(showId)).toEqual({ total: 0, latestPubDate: undefined });
  });
});
