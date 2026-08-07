/**
 * The playlist reads and the two non-trivial writes, against real rows.
 *
 * Three things are load-bearing here and none of them can be checked by
 * reading the schema:
 *
 *  - **Positions survive an arbitrary permutation.** `unique(playlist_id,
 *    position)` is enforced per row as an `UPDATE` walks its result, so the
 *    Mongo shift has no direct translation and the reorder had to be rewritten.
 *    A reversal is the shape that fails for every naive spelling.
 *  - **`canViewPlaylist` agrees with the rows it is asked about.** Playlist
 *    readability is the one catalog predicate that genuinely varies per viewer,
 *    so it is exercised across the whole `visibility × relationship` grid
 *    rather than on the two cases a handler happens to hit.
 *  - **Stats count PLAYABLE tracks only.** A takedown has to shrink a
 *    playlist's duration with no playlist-side bookkeeping.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { PlaylistVisibility } from '@syra/shared-types';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { catalogEntities, imageAssets, tracks } from '../../schema/catalog';
import { playlistCollaborators, playlistTracks, playlists } from '../../schema/library';
import { canViewPlaylist } from '../../catalog/visibility';
import {
  assignPlaylistTrackPositions,
  findCollaboratorOxyUserIds,
  findCollaboratorRole,
  findPlaylistById,
  findPlaylistTracks,
  findPlaylistsForUser,
  refreshPlaylistStats,
} from '../playlists';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const OWNER = 'oxy-owner';
const COLLABORATOR = 'oxy-collaborator';
const STRANGER = 'oxy-stranger';

async function makeTrack(
  over: Partial<typeof tracks.$inferInsert> = {}
): Promise<string> {
  const artistId = uuidv7();
  await getDb()
    .insert(catalogEntities)
    .values({ id: artistId, type: 'artist', name: 'Artist', nameKey: artistId, source: 'upload' });

  const id = uuidv7();
  await getDb().insert(tracks).values({
    id,
    title: 'Track',
    artistId,
    artistName: 'Artist',
    duration: 200,
    source: 'upload',
    ...over,
  });
  return id;
}

async function makePlaylist(
  over: Partial<typeof playlists.$inferInsert> = {}
): Promise<string> {
  const [row] = await getDb()
    .insert(playlists)
    .values({ name: 'Mix', ownerOxyUserId: OWNER, ownerUsername: 'owner', ...over })
    .returning({ id: playlists.id });
  return row.id;
}

/** Put `trackIds` into the playlist at positions `0…n-1`. */
async function fill(playlistId: string, trackIds: string[]): Promise<void> {
  await getDb()
    .insert(playlistTracks)
    .values(
      trackIds.map((trackId, position) => ({
        playlistId,
        trackId,
        addedAt: new Date(),
        addedBy: OWNER,
        position,
      }))
    );
}

async function orderOf(playlistId: string): Promise<string[]> {
  return (await findPlaylistTracks(playlistId)).map((entry) => entry.trackId);
}

describe('assignPlaylistTrackPositions survives a permutation', () => {
  /**
   * The case every naive spelling fails.
   *
   * A single `UPDATE … FROM (VALUES …)` writing the reversal collides on
   * `unique(playlist_id, position)` — the constraint is checked per row, not at
   * statement end — and so does the Mongo-style `$inc` shift. Reversal is the
   * strongest shape because EVERY row's new position is already held by
   * another row that has not moved yet.
   */
  it('reverses a playlist', async () => {
    const ids = [await makeTrack(), await makeTrack(), await makeTrack(), await makeTrack()];
    const playlistId = await makePlaylist();
    await fill(playlistId, ids);

    const reversed = [...ids].reverse();
    await getDb().transaction((tx) => assignPlaylistTrackPositions(tx, playlistId, reversed));

    expect(await orderOf(playlistId)).toEqual(reversed);
  });

  it('rotates a playlist by one, which collides at every position but the last', async () => {
    const ids = [await makeTrack(), await makeTrack(), await makeTrack()];
    const playlistId = await makePlaylist();
    await fill(playlistId, ids);

    const rotated = [ids[2], ids[0], ids[1]];
    await getDb().transaction((tx) => assignPlaylistTrackPositions(tx, playlistId, rotated));

    expect(await orderOf(playlistId)).toEqual(rotated);
  });

  /**
   * Compaction after a delete. The positions left behind are `0, 2, 3` and the
   * targets are `0, 1, 2`, so the row moving `2 → 1` collides with the row
   * still sitting at 1 until it moves — the same failure, one direction down
   * instead of up.
   */
  it('closes the gaps a delete leaves', async () => {
    const ids = [await makeTrack(), await makeTrack(), await makeTrack(), await makeTrack()];
    const playlistId = await makePlaylist();
    await fill(playlistId, ids);

    await getDb()
      .delete(playlistTracks)
      .where(eq(playlistTracks.trackId, ids[1]));

    const remaining = [ids[0], ids[2], ids[3]];
    await getDb().transaction((tx) => assignPlaylistTrackPositions(tx, playlistId, remaining));

    expect(await orderOf(playlistId)).toEqual(remaining);
    expect((await findPlaylistTracks(playlistId)).map((entry) => entry.position)).toEqual([0, 1, 2]);
  });

  it('leaves another playlist alone', async () => {
    const mine = [await makeTrack(), await makeTrack()];
    const theirs = [await makeTrack(), await makeTrack()];
    const [a, b] = [await makePlaylist(), await makePlaylist()];
    await fill(a, mine);
    await fill(b, theirs);

    await getDb().transaction((tx) => assignPlaylistTrackPositions(tx, a, [...mine].reverse()));

    expect(await orderOf(b)).toEqual(theirs);
  });

  it('an empty order changes nothing', async () => {
    const ids = [await makeTrack(), await makeTrack()];
    const playlistId = await makePlaylist();
    await fill(playlistId, ids);

    await getDb().transaction((tx) => assignPlaylistTrackPositions(tx, playlistId, []));

    expect(await orderOf(playlistId)).toEqual(ids);
  });
});

describe('canViewPlaylist, against the rows the loaders return', () => {
  /**
   * The whole grid, because playlist readability is the one catalog predicate
   * that varies per viewer and a handler only ever exercises the two cases it
   * happens to hit.
   *
   * `unlisted` is in the fixture set on purpose: it is neither `public` nor the
   * `private` default, and a predicate written as `visibility !== 'private'`
   * would agree with the correct one on every case except this row.
   */
  const GRID: readonly {
    readonly visibility: PlaylistVisibility;
    readonly viewer: string | undefined;
    readonly readable: boolean;
  }[] = [
    { visibility: PlaylistVisibility.PUBLIC, viewer: undefined, readable: true },
    { visibility: PlaylistVisibility.PUBLIC, viewer: STRANGER, readable: true },
    { visibility: PlaylistVisibility.PUBLIC, viewer: OWNER, readable: true },
    { visibility: PlaylistVisibility.PUBLIC, viewer: COLLABORATOR, readable: true },
    { visibility: PlaylistVisibility.PRIVATE, viewer: undefined, readable: false },
    { visibility: PlaylistVisibility.PRIVATE, viewer: STRANGER, readable: false },
    { visibility: PlaylistVisibility.PRIVATE, viewer: OWNER, readable: true },
    { visibility: PlaylistVisibility.PRIVATE, viewer: COLLABORATOR, readable: true },
    { visibility: PlaylistVisibility.UNLISTED, viewer: undefined, readable: false },
    { visibility: PlaylistVisibility.UNLISTED, viewer: STRANGER, readable: false },
    { visibility: PlaylistVisibility.UNLISTED, viewer: OWNER, readable: true },
    { visibility: PlaylistVisibility.UNLISTED, viewer: COLLABORATOR, readable: true },
  ];

  for (const { visibility, viewer, readable } of GRID) {
    it(`${visibility} playlist, viewed by ${viewer ?? 'nobody'}`, async () => {
      const playlistId = await makePlaylist({ visibility });
      await getDb().insert(playlistCollaborators).values({
        playlistId,
        oxyUserId: COLLABORATOR,
        username: 'collab',
        role: 'viewer',
        addedAt: new Date(),
      });

      // Loaded back rather than asserted against the object just written: the
      // predicate's agreement with the DATABASE is the property, and a loader
      // that returned an empty collaborator list would otherwise pass.
      const row = await findPlaylistById(playlistId);
      if (!row) throw new Error('the playlist just written was not found');
      const collaboratorOxyUserIds = await findCollaboratorOxyUserIds(playlistId);

      expect(
        `${visibility}/${viewer ?? 'anon'}: ${canViewPlaylist({ ...row, collaboratorOxyUserIds }, viewer)}`
      ).toBe(`${visibility}/${viewer ?? 'anon'}: ${readable}`);
    });
  }

  it('a viewer with NO collaborator row is not admitted by an empty list', async () => {
    // The negative control for the loader: with no collaborators at all, the
    // private cases must still refuse everyone but the owner.
    const playlistId = await makePlaylist({ visibility: PlaylistVisibility.PRIVATE });
    const row = await findPlaylistById(playlistId);
    if (!row) throw new Error('the playlist just written was not found');
    const collaboratorOxyUserIds = await findCollaboratorOxyUserIds(playlistId);

    expect(collaboratorOxyUserIds).toEqual([]);
    expect(canViewPlaylist({ ...row, collaboratorOxyUserIds }, COLLABORATOR)).toBe(false);
    expect(canViewPlaylist({ ...row, collaboratorOxyUserIds }, OWNER)).toBe(true);
  });
});

describe('the edit-permission role', () => {
  /**
   * `viewer` is the fixture that matters: the edit check accepts `editor` and
   * `owner` and refuses `viewer`, so a fixture set with only editors cannot
   * tell "reads the role" from "returns true whenever a row exists".
   */
  it('is read back exactly as stored, for each of the three roles', async () => {
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      const playlistId = await makePlaylist();
      await getDb().insert(playlistCollaborators).values({
        playlistId,
        oxyUserId: COLLABORATOR,
        username: 'collab',
        role,
        addedAt: new Date(),
      });

      expect(await findCollaboratorRole(playlistId, COLLABORATOR)).toBe(role);
      expect(await findCollaboratorRole(playlistId, STRANGER)).toBeUndefined();
    }
  });
});

describe('findPlaylistsForUser', () => {
  it('returns the ones a user owns and the ones they collaborate on, and no others', async () => {
    const owned = await makePlaylist({ name: 'Owned' });
    const collaborated = await makePlaylist({ name: 'Collaborated', ownerOxyUserId: STRANGER });
    await makePlaylist({ name: 'Unrelated', ownerOxyUserId: STRANGER });

    await getDb().insert(playlistCollaborators).values({
      playlistId: collaborated,
      oxyUserId: OWNER,
      username: 'owner',
      role: 'editor',
      addedAt: new Date(),
    });

    const ids = (await findPlaylistsForUser(OWNER)).map((row) => row.id).sort();
    expect(ids).toEqual([owned, collaborated].sort());
  });

  it('returns a playlist once when the user both owns it and collaborates on it', async () => {
    // Nothing in the app writes a collaborator row for an owner today, so this
    // is about the UNION rather than about a real flow — but a `union all`
    // would return it twice and read as a duplicate to every client.
    const playlistId = await makePlaylist();
    await getDb().insert(playlistCollaborators).values({
      playlistId,
      oxyUserId: OWNER,
      username: 'owner',
      role: 'owner',
      addedAt: new Date(),
    });

    expect((await findPlaylistsForUser(OWNER)).map((row) => row.id)).toEqual([playlistId]);
  });

  /**
   * The cover-art term has to come FIRST, ahead of the date.
   *
   * The playlist with art is created SECOND, so it is also the newer one — and
   * an ordering that dropped the image term entirely would still put it first,
   * for the wrong reason. The older row is the one that carries the art, which
   * is the only arrangement where the two ordering terms disagree.
   */
  it('puts playlists with cover art ahead of newer ones without', async () => {
    const coverArtId = uuidv7();
    await getDb().insert(imageAssets).values({
      id: coverArtId,
      s3Key: `k/${coverArtId}`,
      filename: 'c.jpg',
      contentType: 'image/jpeg',
      byteSize: 1,
      ownerType: 'album',
    });

    await makePlaylist({
      name: 'Older, with art',
      coverArtId,
      createdAt: new Date('2020-01-01T00:00:00Z'),
    });
    await makePlaylist({ name: 'Newer, no art', createdAt: new Date('2026-01-01T00:00:00Z') });

    expect((await findPlaylistsForUser(OWNER)).map((row) => row.name)).toEqual([
      'Older, with art',
      'Newer, no art',
    ]);
  });

  it('orders by newest within the same image state', async () => {
    await makePlaylist({ name: 'Older', createdAt: new Date('2020-01-01T00:00:00Z') });
    await makePlaylist({ name: 'Newer', createdAt: new Date('2026-01-01T00:00:00Z') });

    expect((await findPlaylistsForUser(OWNER)).map((row) => row.name)).toEqual(['Newer', 'Older']);
  });
});

describe('refreshPlaylistStats counts only playable tracks', () => {
  /**
   * All three states are in the fixture, and that is the point: a playlist
   * whose tracks are all playable cannot tell a stats query that filters from
   * one that does not.
   */
  it('excludes an unavailable track and a copyright-removed one', async () => {
    const playable = await makeTrack({ duration: 100 });
    const unavailable = await makeTrack({ duration: 1000, isAvailable: false });
    const removed = await makeTrack({ duration: 1000, copyrightRemoved: true });

    const playlistId = await makePlaylist();
    await fill(playlistId, [playable, unavailable, removed]);
    await refreshPlaylistStats(getDb(), playlistId);

    const row = await findPlaylistById(playlistId);
    expect(`${row?.trackCount} tracks, ${row?.totalDuration}s`).toBe('1 tracks, 100s');
  });

  it('sums durations rather than concatenating them', async () => {
    // `sum()` over a `double precision` column comes back from postgres.js as a
    // numeric STRING; `'100' + '200'` is `'100200'`, which would look like a
    // very long playlist and pass any assertion that only checked truthiness.
    const playlistId = await makePlaylist();
    await fill(playlistId, [
      await makeTrack({ duration: 100 }),
      await makeTrack({ duration: 200 }),
    ]);
    await refreshPlaylistStats(getDb(), playlistId);

    const row = await findPlaylistById(playlistId);
    expect(row?.totalDuration).toBe(300);
  });

  it('an empty playlist reports zero rather than null', async () => {
    const playlistId = await makePlaylist();
    await refreshPlaylistStats(getDb(), playlistId);

    const row = await findPlaylistById(playlistId);
    expect(`${row?.trackCount}/${row?.totalDuration}`).toBe('0/0');
  });
});
