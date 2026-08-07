/**
 * `db/user/listening.ts` and `db/user/relations.ts`.
 *
 * The two behaviours worth pinning are the paging (because the ORDER is the
 * co-occurrence algorithm, not a preference) and the graph rewrite (because the
 * Mongo version had a window in which every "related" shelf was empty).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { count, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { catalogEntities, tracks } from '../../schema/catalog';
import { catalogRelations } from '../../schema/user';
import {
  findRecentTrackIds,
  forEachMinableEvent,
  insertListeningEvent,
  type MinableEvent,
} from '../listening';
import { findRelatedEdges, replaceRelationGraph } from '../relations';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

async function makeArtist(): Promise<string> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: `Artist ${suffix}`,
      nameKey: `artist-${suffix}`,
      source: 'upload',
    })
    .returning({ id: catalogEntities.id });
  return artist.id;
}

async function makeTrack(artistId: string): Promise<string> {
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: `Track ${uuidv7()}`,
      artistId,
      artistName: 'Someone',
      duration: 200,
      source: 'upload',
      status: 'ready',
    })
    .returning({ id: tracks.id });
  return track.id;
}

interface PlayOptions {
  completion?: number;
  skipped?: boolean;
  playedAt?: Date;
}

async function play(
  oxyUserId: string,
  trackId: string,
  artistId: string,
  options: PlayOptions = {}
): Promise<void> {
  await insertListeningEvent({
    oxyUserId,
    trackId,
    artistId,
    listenedSec: 120,
    completion: options.completion ?? 0.9,
    skipped: options.skipped ?? false,
    source: 'radio',
    playedAt: options.playedAt ?? new Date(),
  });
}

describe('listening events', () => {
  it('refuses an event for a track that does not exist', async () => {
    const artistId = await makeArtist();

    // `track_id` is a real foreign key, where Mongo stored the string.
    await expect(
      play('oxy-1', 'no-such-track', artistId)
    ).rejects.toThrow();
  });

  it('reads one listener s most recent track ids, newest first', async () => {
    const artistId = await makeArtist();
    const first = await makeTrack(artistId);
    const second = await makeTrack(artistId);
    const other = await makeTrack(artistId);

    await play('oxy-1', first, artistId, { playedAt: new Date(Date.now() - 60_000) });
    await play('oxy-1', second, artistId, { playedAt: new Date() });
    await play('oxy-2', other, artistId, { playedAt: new Date() });

    expect(await findRecentTrackIds('oxy-1', 10)).toEqual([second, first]);
  });

  /**
   * Duplicates are NOT collapsed: `limit` means the most recent N EVENTS, which
   * is what the Mongo read returned, and the caller folds the result into a
   * `Set` with its liked tracks anyway. A `distinct` here would change what the
   * limit counts.
   */
  it('returns the most recent N events, not the most recent N distinct tracks', async () => {
    const artistId = await makeArtist();
    const repeated = await makeTrack(artistId);
    const older = await makeTrack(artistId);

    await play('oxy-1', older, artistId, { playedAt: new Date(Date.now() - 60_000) });
    await play('oxy-1', repeated, artistId, { playedAt: new Date(Date.now() - 2_000) });
    await play('oxy-1', repeated, artistId, { playedAt: new Date() });

    expect(await findRecentTrackIds('oxy-1', 2)).toEqual([repeated, repeated]);
  });
});

describe('the miner walks the log', () => {
  /**
   * Collect every event the miner visits, in the order it visits them.
   *
   * `pageSize` defaults to SEVEN, not to the production 10,000. With one page
   * bigger than the fixture the first query returns everything and the keyset
   * seek never executes — so a walk that paged incorrectly, or did not page at
   * all, would pass every assertion below. Seven against a 40-event fixture is
   * six page boundaries.
   */
  async function walk(maxEvents = 1000, pageSize = 7): Promise<MinableEvent[]> {
    const seen: MinableEvent[] = [];
    await forEachMinableEvent(
      {
        since: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        minCompletion: 0.3,
        maxEvents,
        pageSize,
      },
      (event) => seen.push(event)
    );
    return seen;
  }

  it('skips skips and short listens', async () => {
    const artistId = await makeArtist();
    const kept = await makeTrack(artistId);
    const skipped = await makeTrack(artistId);
    const brief = await makeTrack(artistId);

    await play('oxy-1', kept, artistId, { completion: 0.9 });
    await play('oxy-1', skipped, artistId, { completion: 0.9, skipped: true });
    await play('oxy-1', brief, artistId, { completion: 0.1 });

    expect((await walk()).map((event) => event.trackId)).toEqual([kept]);
  });

  it('ignores anything older than the window', async () => {
    const artistId = await makeArtist();
    const recent = await makeTrack(artistId);
    const ancient = await makeTrack(artistId);

    await play('oxy-1', recent, artistId);
    await play('oxy-1', ancient, artistId, {
      playedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    });

    expect((await walk()).map((event) => event.trackId)).toEqual([recent]);
  });

  /**
   * THE ordering property, and the reason paging is a keyset rather than an
   * `offset`. The miner splits a user's plays into sessions by the gap between
   * consecutive `played_at` values, so a page boundary that reordered rows
   * would invent or destroy sessions — a wrong graph rather than a slow one.
   *
   * The fixture puts several events on ONE `played_at`, which is the input that
   * makes a two-column seek and a three-column one disagree: without `id` in the
   * key the resumed page either repeats or skips the rows sharing that instant.
   */
  it('visits every event once, in (user, playedAt) order, across page boundaries', async () => {
    const artistId = await makeArtist();
    const trackIds = await Promise.all(Array.from({ length: 40 }, () => makeTrack(artistId)));

    const sharedInstant = new Date(Date.now() - 5_000);
    for (const [index, trackId] of trackIds.entries()) {
      // Users interleaved on purpose, so a walk that ignored `oxy_user_id`
      // ordering would produce a different sequence.
      const user = index % 2 === 0 ? 'oxy-a' : 'oxy-b';
      await play(user, trackId, artistId, {
        // A third of the events share one timestamp exactly.
        playedAt: index % 3 === 0 ? sharedInstant : new Date(Date.now() - index * 1_000),
      });
    }

    const seen = await walk();

    expect(seen).toHaveLength(40);
    // Six page boundaries at a page size of seven — without them the seek below
    // is never executed and this test cannot fail.
    expect(Math.ceil(40 / 7)).toBeGreaterThan(1);
    // Every event exactly once — a broken seek would repeat or drop.
    expect(new Set(seen.map((event) => event.trackId)).size).toBe(40);

    // And in the total order the sessioniser depends on.
    const keys = seen.map((event) => `${event.oxyUserId}|${event.playedAt.toISOString()}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('stops at maxEvents', async () => {
    const artistId = await makeArtist();
    const trackIds = await Promise.all(Array.from({ length: 10 }, () => makeTrack(artistId)));
    for (const trackId of trackIds) await play('oxy-1', trackId, artistId);

    expect(await walk(4)).toHaveLength(4);
  });
});

describe('the relation graph is replaced atomically', () => {
  it('writes the edges a pass mined', async () => {
    const written = await replaceRelationGraph('artist', [
      { sourceId: 'a', targetId: 'b', score: 0.9, coCount: 10 },
      { sourceId: 'a', targetId: 'c', score: 0.4, coCount: 4 },
    ]);

    expect(written).toBe(2);
    expect(await findRelatedEdges('artist', ['a'], 10)).toEqual([
      { targetId: 'b', score: 0.9 },
      { targetId: 'c', score: 0.4 },
    ]);
  });

  it('replaces the previous graph rather than merging into it', async () => {
    await replaceRelationGraph('artist', [
      { sourceId: 'a', targetId: 'stale', score: 0.9, coCount: 10 },
    ]);
    await replaceRelationGraph('artist', [
      { sourceId: 'a', targetId: 'fresh', score: 0.5, coCount: 5 },
    ]);

    expect(await findRelatedEdges('artist', ['a'], 10)).toEqual([
      { targetId: 'fresh', score: 0.5 },
    ]);
  });

  /**
   * The kinds are independent graphs sharing a table, and the job rewrites them
   * in two separate passes — so a delete that ignored `kind` would wipe the
   * artist graph every time the track graph was written.
   */
  it('leaves the other kind alone', async () => {
    await replaceRelationGraph('artist', [
      { sourceId: 'a', targetId: 'b', score: 0.9, coCount: 10 },
    ]);
    await replaceRelationGraph('track', [
      { sourceId: 't1', targetId: 't2', score: 0.8, coCount: 8 },
    ]);

    expect(await findRelatedEdges('artist', ['a'], 10)).toHaveLength(1);
    expect(await findRelatedEdges('track', ['t1'], 10)).toHaveLength(1);
  });

  /**
   * "This pass mined nothing" and "leave last pass's edges in place" are
   * different outcomes, and the job means the first.
   */
  it('an empty pass still clears the kind', async () => {
    await replaceRelationGraph('artist', [
      { sourceId: 'a', targetId: 'b', score: 0.9, coCount: 10 },
    ]);

    expect(await replaceRelationGraph('artist', [])).toBe(0);

    const [row] = await getDb()
      .select({ value: count() })
      .from(catalogRelations)
      .where(eq(catalogRelations.kind, 'artist'));
    expect(row.value).toBe(0);
  });

  it('sums nothing but returns edges best score first across several sources', async () => {
    await replaceRelationGraph('track', [
      { sourceId: 's1', targetId: 'x', score: 0.3, coCount: 3 },
      { sourceId: 's2', targetId: 'x', score: 0.7, coCount: 7 },
      { sourceId: 's2', targetId: 'y', score: 0.5, coCount: 5 },
    ]);

    // Edges, not an aggregate: `radioPools` weights a target by how many of the
    // station's sources reach it, and that count is lost by summing here.
    expect(await findRelatedEdges('track', ['s1', 's2'], 10)).toEqual([
      { targetId: 'x', score: 0.7 },
      { targetId: 'y', score: 0.5 },
      { targetId: 'x', score: 0.3 },
    ]);
  });

  it('answers nothing for no sources without touching the database', async () => {
    expect(await findRelatedEdges('artist', [], 10)).toEqual([]);
  });
});
