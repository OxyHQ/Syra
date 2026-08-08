/**
 * The four library memberships, against real rows.
 *
 * Three properties the Mongo arrays had only by convention, and one they did
 * not have at all:
 *
 *  - idempotent (`$addToSet` → `unique(oxy_user_id, target_id)` +
 *    `onConflictDoNothing`),
 *  - ORDERED oldest-first, which `services/radio/radioSeed.ts` reads as
 *    freshness off the tail,
 *  - removing what is not there is a successful no-op,
 *  - and adding something that does not exist is now REFUSED, because every
 *    target column is a real foreign key.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { albums, catalogEntities, imageAssets, tracks } from '../../schema/catalog';
import { playlists, userLikedTracks } from '../../schema/library';
import { addMembership, listMembership, removeMembership } from '../membership';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const USER = 'oxy-user-lib';

async function makeArtist(): Promise<string> {
  const id = uuidv7();
  await getDb()
    .insert(catalogEntities)
    .values({ id, type: 'artist', name: 'Artist', nameKey: id, source: 'upload' });
  return id;
}

async function makeTrack(): Promise<string> {
  const id = uuidv7();
  await getDb().insert(tracks).values({
    id,
    title: 'Track',
    artistId: await makeArtist(),
    artistName: 'Artist',
    duration: 200,
    source: 'upload',
  });
  return id;
}

async function makeAlbum(): Promise<string> {
  const coverArtId = uuidv7();
  await getDb().insert(imageAssets).values({
    id: coverArtId,
    s3Key: `k/${coverArtId}`,
    filename: 'c.jpg',
    contentType: 'image/jpeg',
    byteSize: 1,
    ownerType: 'album',
  });

  const id = uuidv7();
  await getDb().insert(albums).values({
    id,
    title: 'Album',
    artistId: await makeArtist(),
    artistName: 'Artist',
    releaseDate: '2020-01-01',
    coverArtId,
  });
  return id;
}

async function makePlaylist(): Promise<string> {
  const [row] = await getDb()
    .insert(playlists)
    .values({ name: 'Mix', ownerOxyUserId: USER, ownerUsername: 'user' })
    .returning({ id: playlists.id });
  return row.id;
}

describe('adding is idempotent', () => {
  it('a second like of the same track adds no second row', async () => {
    const trackId = await makeTrack();

    expect(await addMembership('likedTracks', USER, trackId)).toBe('added');
    expect(await addMembership('likedTracks', USER, trackId)).toBe('added');

    expect(await listMembership('likedTracks', USER)).toEqual([trackId]);
  });

  it('two users can like the same track', async () => {
    const trackId = await makeTrack();

    await addMembership('likedTracks', USER, trackId);
    await addMembership('likedTracks', 'oxy-user-other', trackId);

    expect(await listMembership('likedTracks', USER)).toEqual([trackId]);
    expect(await listMembership('likedTracks', 'oxy-user-other')).toEqual([trackId]);
  });
});

describe('the list is ordered by when the membership was added', () => {
  /**
   * The fixture is deliberately in the ONE shape that tells the two candidate
   * orderings apart.
   *
   * `user_liked_tracks.id` is a uuid v7, which is time-sortable — so a list
   * ordered by the PRIMARY KEY and a list ordered by `created_at` agree on
   * every fixture where rows are inserted in the order they are meant to come
   * back. Writing `created_at` backwards makes them disagree, and only then
   * does the assertion mean "ordered by created_at" rather than "ordered by
   * anything monotonic".
   *
   * That distinction is the whole reason migration `0020` added the column: it
   * is what `radioSeed`'s `likedTracks.slice(-N)` reads as "the freshest
   * likes".
   */
  it('oldest first, by created_at and not by the id', async () => {
    const [first, second, third] = [await makeTrack(), await makeTrack(), await makeTrack()];

    // Inserted first/second/third — ids ascend in that order — while the
    // timestamps say the opposite.
    await getDb().insert(userLikedTracks).values([
      { oxyUserId: USER, trackId: first, createdAt: new Date('2026-03-01T00:00:00Z') },
      { oxyUserId: USER, trackId: second, createdAt: new Date('2026-02-01T00:00:00Z') },
      { oxyUserId: USER, trackId: third, createdAt: new Date('2026-01-01T00:00:00Z') },
    ]);

    expect(await listMembership('likedTracks', USER)).toEqual([third, second, first]);
  });

  it('a fresh like lands at the END, where radioSeed reads from', async () => {
    const older = await makeTrack();
    await getDb()
      .insert(userLikedTracks)
      .values({ oxyUserId: USER, trackId: older, createdAt: new Date('2020-01-01T00:00:00Z') });

    const newest = await makeTrack();
    await addMembership('likedTracks', USER, newest);

    expect((await listMembership('likedTracks', USER)).at(-1)).toBe(newest);
  });
});

describe('adding something that does not exist is refused', () => {
  /**
   * Both id shapes, because they fail at different layers and only one of them
   * used to be reachable at all.
   *
   * A malformed id simply matches no row in `tracks`, and a well-formed uuid v7
   * that names nothing does too — but the second is the shape a client actually
   * sends after a track is deleted, and an `ObjectId.isValid`-style guard would
   * have let it through. Both must come back as `'missing-target'` rather than
   * as a thrown `23503` the handler turns into a 500.
   */
  it('a malformed track id', async () => {
    expect(await addMembership('likedTracks', USER, 'not-an-id')).toBe('missing-target');
    expect(await listMembership('likedTracks', USER)).toEqual([]);
  });

  it('a well-formed track id naming no track', async () => {
    expect(await addMembership('likedTracks', USER, uuidv7())).toBe('missing-target');
    expect(await listMembership('likedTracks', USER)).toEqual([]);
  });

  it('holds for all four memberships, each against its own table', async () => {
    // One case per relation, so a copy-paste error in the registry — a wrong
    // constraint name, an insert into the wrong table — fails for exactly the
    // relation that carries it rather than being masked by the other three.
    expect(await addMembership('savedAlbums', USER, uuidv7())).toBe('missing-target');
    expect(await addMembership('followedArtists', USER, uuidv7())).toBe('missing-target');
    expect(await addMembership('savedPlaylists', USER, uuidv7())).toBe('missing-target');

    expect(await addMembership('savedAlbums', USER, await makeAlbum())).toBe('added');
    expect(await addMembership('followedArtists', USER, await makeArtist())).toBe('added');
    expect(await addMembership('savedPlaylists', USER, await makePlaylist())).toBe('added');

    expect((await listMembership('savedAlbums', USER)).length).toBe(1);
    expect((await listMembership('followedArtists', USER)).length).toBe(1);
    expect((await listMembership('savedPlaylists', USER)).length).toBe(1);
  });
});

describe('removing is a no-op when there is nothing to remove', () => {
  /**
   * The asymmetry with adding, asserted rather than described. A foreign key
   * constrains what may be STORED; it says nothing about what may be asked for,
   * and the Mongo `$pull` against an upserted document was equally happy to
   * remove nothing.
   */
  it('unliking a track the user never liked', async () => {
    await removeMembership('likedTracks', USER, await makeTrack());
    expect(await listMembership('likedTracks', USER)).toEqual([]);
  });

  it('unliking a track that does not exist at all', async () => {
    await removeMembership('likedTracks', USER, uuidv7());
    await removeMembership('likedTracks', USER, 'not-an-id');
    expect(await listMembership('likedTracks', USER)).toEqual([]);
  });

  it('removes only the named membership, and only for that user', async () => {
    const [kept, dropped] = [await makeTrack(), await makeTrack()];
    await addMembership('likedTracks', USER, kept);
    await addMembership('likedTracks', USER, dropped);
    await addMembership('likedTracks', 'oxy-user-other', dropped);

    await removeMembership('likedTracks', USER, dropped);

    expect(await listMembership('likedTracks', USER)).toEqual([kept]);
    expect(await listMembership('likedTracks', 'oxy-user-other')).toEqual([dropped]);
  });
});

describe('a deleted target takes its memberships with it', () => {
  /**
   * `on delete cascade` on every junction. Under Mongo the array kept the id of
   * a deleted playlist forever — `Library.savedPlaylists` was documented as a
   * real orphan — and this is the change that fixes it with no application
   * code at all.
   */
  it('deleting a playlist removes it from everybody who saved it', async () => {
    const playlistId = await makePlaylist();
    await addMembership('savedPlaylists', USER, playlistId);
    await addMembership('savedPlaylists', 'oxy-user-other', playlistId);

    await getDb().delete(playlists).where(eq(playlists.id, playlistId));

    expect(await listMembership('savedPlaylists', USER)).toEqual([]);
    expect(await listMembership('savedPlaylists', 'oxy-user-other')).toEqual([]);
  });
});
