import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { albums, catalogEntities, imageAssets, tracks } from '../db/schema/catalog';
import { playlists, recentlyPlayed } from '../db/schema/library';
import { podcasts } from '../db/schema/podcasts';
import { subscribeToPodcast } from '../db/podcasts/subscriptions';
import { findTasteWeights } from '../db/user/taste';
import {
  followArtist,
  getLikedTracks,
  getRecentlyPlayed,
  getUserLibrary,
  likeTrack,
  recordRecentlyPlayed,
  saveAlbum,
  savePlaylist,
  unlikeTrack,
} from './library.controller';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { NextFunction, Response } from 'express';

/**
 * The library API on Postgres.
 *
 * `db/library/__tests__/membership.test.ts` owns the junction semantics; this
 * file owns the wire behaviour that CHANGED, which is one thing and it is not
 * cosmetic: liking, saving or following something that does not exist used to
 * store the id and answer `200`, and now answers `404`. Every target column is
 * a real foreign key, so the alternative was a `23503` reaching the client as a
 * 500.
 *
 * BOTH stores, because `likeTrack` and `followArtist` fold the action into the
 * listener's taste profile and `UserTasteProfile` is Task 15's — still
 * Mongoose. Without a Mongo connection those handlers do not fail, they HANG:
 * Mongoose buffers the command until a connection arrives, so the symptom is a
 * 5-second test timeout naming the test rather than the missing store.
 */

beforeAll(async () => {
  await connectDb();
});
afterEach(async () => {
  await clearDb();
});
afterAll(async () => {
  await disconnectDb();
});

const USER = 'oxy-listener';

interface CapturedRes {
  _status: number;
  _body: unknown;
  status(code: number): CapturedRes;
  json(body: unknown): CapturedRes;
}

function makeRes(): CapturedRes {
  return {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
}

function makeReq(
  over: { params?: Record<string, string>; body?: unknown; userId?: string } = {}
): AuthRequest {
  return {
    params: over.params ?? {},
    query: {},
    body: over.body ?? {},
    user: over.userId ? { id: over.userId } : undefined,
  } as unknown as AuthRequest;
}

const next: NextFunction = (err?: unknown) => {
  if (err) throw err;
};

async function makeArtist(): Promise<string> {
  const id = uuidv7();
  await getDb()
    .insert(catalogEntities)
    .values({ id, type: 'artist', name: 'Artist', nameKey: id, source: 'upload' });
  return id;
}

async function makeTrack(over: Partial<typeof tracks.$inferInsert> = {}): Promise<string> {
  const id = uuidv7();
  await getDb().insert(tracks).values({
    id,
    title: 'Track',
    artistId: await makeArtist(),
    artistName: 'Artist',
    duration: 200,
    source: 'upload',
    ...over,
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

/**
 * A show, with `status`/`visibility`/`ownerOxyUserId` left to the caller.
 *
 * Both columns default to their most permissive value (`active` / `public`), so
 * a fixture that does not name them is the case a visibility predicate lets
 * through — which is what the positive control below needs and what every
 * refusal has to differ from in exactly one column.
 */
async function makeShow(over: Partial<typeof podcasts.$inferInsert> = {}): Promise<string> {
  const id = uuidv7();
  await getDb().insert(podcasts).values({ id, title: 'A Show', source: 'syra', ...over });
  return id;
}

async function makePlaylist(): Promise<string> {
  const [row] = await getDb()
    .insert(playlists)
    .values({ name: 'Mix', ownerOxyUserId: USER, ownerUsername: 'listener' })
    .returning({ id: playlists.id });
  return row.id;
}

async function call(
  handler: (req: AuthRequest, res: Response, next: NextFunction) => Promise<unknown>,
  over: Parameters<typeof makeReq>[0]
): Promise<CapturedRes> {
  const res = makeRes();
  await handler(makeReq(over), res as unknown as Response, next);
  return res;
}

describe('GET /api/library', () => {
  it('answers empty lists for a listener who has done nothing', async () => {
    const res = await call(getUserLibrary, { userId: USER });

    expect(res._body).toEqual({
      oxyUserId: USER,
      likedTracks: [],
      savedAlbums: [],
      followedArtists: [],
      savedPlaylists: [],
      subscribedPodcasts: [],
    });
  });

  it('answers each list from its own junction table', async () => {
    // One of each, so a handler that read the same table four times — the
    // shape a copy-paste in the relation registry produces — cannot pass.
    const trackId = await makeTrack();
    const albumId = await makeAlbum();
    const artistId = await makeArtist();
    const playlistId = await makePlaylist();
    const podcastId = await makeShow();

    await call(likeTrack, { params: { id: trackId }, userId: USER });
    await call(saveAlbum, { params: { id: albumId }, userId: USER });
    await call(followArtist, { params: { id: artistId }, userId: USER });
    await call(savePlaylist, { params: { id: playlistId }, userId: USER });
    // The one membership with no `/api/library` write of its own: subscribing
    // bumps `podcasts.subscriber_count` in the same transaction, so it stays
    // with `POST /api/podcasts/:id/subscribe` rather than growing a second
    // writer here. This read aggregates it; it does not own it.
    await subscribeToPodcast(USER, podcastId);

    expect(await call(getUserLibrary, { userId: USER }).then((res) => res._body)).toEqual({
      oxyUserId: USER,
      likedTracks: [trackId],
      savedAlbums: [albumId],
      followedArtists: [artistId],
      savedPlaylists: [playlistId],
      subscribedPodcasts: [podcastId],
    });
  });

  it('requires auth', async () => {
    expect((await call(getUserLibrary, {}))._status).toBe(401);
  });

  /**
   * The podcast arm, at the wire.
   *
   * `db/podcasts/__tests__/subscriptions.test.ts` owns the predicate itself;
   * these assert that the HANDLER goes through it — a controller wired to
   * `listSubscribedPodcastIds` instead would pass every other test in this file
   * and hand a stranger the id of a private show.
   */
  it('omits a subscribed show whose creator made it private', async () => {
    const visible = await makeShow();
    const hidden = await makeShow({ visibility: 'private', ownerOxyUserId: 'someone-else' });
    await subscribeToPodcast(USER, visible);
    await subscribeToPodcast(USER, hidden);

    // Both states in the fixture: a handler returning nothing at all, and one
    // returning everything, each fail on one half of this.
    expect(await call(getUserLibrary, { userId: USER }).then((res) => res._body)).toMatchObject({
      subscribedPodcasts: [visible],
    });
  });

  it('omits a subscribed show its creator unpublished', async () => {
    const visible = await makeShow();
    const hidden = await makeShow({ status: 'unavailable' });
    await subscribeToPodcast(USER, visible);
    await subscribeToPodcast(USER, hidden);

    expect(await call(getUserLibrary, { userId: USER }).then((res) => res._body)).toMatchObject({
      subscribedPodcasts: [visible],
    });
  });

  it('keeps the caller\'s OWN private show in their library', async () => {
    // The owner arm has to survive the trip through the handler, or making your
    // own show private empties it out of your own library.
    const mine = await makeShow({ visibility: 'private', ownerOxyUserId: USER });
    await subscribeToPodcast(USER, mine);

    expect(await call(getUserLibrary, { userId: USER }).then((res) => res._body)).toMatchObject({
      subscribedPodcasts: [mine],
    });
  });
});

describe('adding something that does not exist is a 404', () => {
  /**
   * Four endpoints, four tables, four foreign keys. Each is asserted
   * separately because each names its own constraint in the relation registry,
   * and a wrong name there means the `23503` is rethrown as a 500 for that ONE
   * membership while the other three keep working.
   */
  it('likeTrack', async () => {
    const res = await call(likeTrack, { params: { id: uuidv7() }, userId: USER });
    expect(`${res._status} ${JSON.stringify(res._body)}`).toBe('404 {"error":"Track not found"}');
  });

  it('saveAlbum', async () => {
    const res = await call(saveAlbum, { params: { id: uuidv7() }, userId: USER });
    expect(`${res._status} ${JSON.stringify(res._body)}`).toBe('404 {"error":"Album not found"}');
  });

  it('followArtist', async () => {
    const res = await call(followArtist, { params: { id: uuidv7() }, userId: USER });
    expect(`${res._status} ${JSON.stringify(res._body)}`).toBe('404 {"error":"Artist not found"}');
  });

  it('savePlaylist', async () => {
    const res = await call(savePlaylist, { params: { id: uuidv7() }, userId: USER });
    expect(`${res._status} ${JSON.stringify(res._body)}`).toBe('404 {"error":"Playlist not found"}');
  });

  it('leaves the library untouched', async () => {
    await call(likeTrack, { params: { id: uuidv7() }, userId: USER });
    expect(await call(getUserLibrary, { userId: USER }).then((res) => res._body)).toMatchObject({
      likedTracks: [],
    });
  });

  /**
   * And the side effect does not run either.
   *
   * `applyLikeSignal` creates a taste profile for the listener from the track's
   * genre and artist. Running it for a track that does not exist would fold a
   * signal about nothing into their taste — the "half-connected mechanism" this
   * port keeps finding — so the 404 has to come BEFORE it.
   */
  it('does not fold a taste signal for a track that does not exist', async () => {
    await call(likeTrack, { params: { id: uuidv7() }, userId: USER });
    await call(followArtist, { params: { id: uuidv7() }, userId: USER });

    expect(await findTasteWeights(USER)).toBeUndefined();

    // The positive control: a real like DOES create one, so the assertion above
    // cannot pass merely because nothing ever writes a profile.
    await call(likeTrack, { params: { id: await makeTrack() }, userId: USER });
    expect(await findTasteWeights(USER)).toBeDefined();
  });
});

describe('removing something that does not exist is still a 200', () => {
  /**
   * The asymmetry, at the wire. A foreign key constrains what may be STORED,
   * not what may be asked for — and unliking a track that has since been
   * deleted is a request a real client makes.
   */
  it('unlikeTrack on an id naming nothing', async () => {
    const res = await call(unlikeTrack, { params: { id: uuidv7() }, userId: USER });
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true, likedTracks: [] });
  });
});

describe('GET /api/library/tracks', () => {
  it('returns the liked tracks as full track objects', async () => {
    const trackId = await makeTrack();
    await call(likeTrack, { params: { id: trackId }, userId: USER });

    const res = await call(getLikedTracks, { userId: USER });
    const body = res._body as { tracks: { id: string; title: string }[]; total: number };

    expect(body.total).toBe(1);
    expect(body.tracks[0]).toMatchObject({ id: trackId, title: 'Track' });
  });

  /**
   * A liked track that is later taken down drops out of the list.
   *
   * The like ROW survives — the takedown sets a flag, it does not delete the
   * track — so this is the catalog predicate doing the filtering, not the
   * cascade. Both states are in the fixture, or a query with no predicate at
   * all would pass.
   */
  it('omits a liked track that is no longer playable', async () => {
    const playable = await makeTrack();
    const removed = await makeTrack({ copyrightRemoved: true });
    const unavailable = await makeTrack({ isAvailable: false });

    for (const id of [playable, removed, unavailable]) {
      await call(likeTrack, { params: { id }, userId: USER });
    }

    const res = await call(getLikedTracks, { userId: USER });
    const body = res._body as { tracks: { id: string }[] };
    expect(body.tracks.map((track) => track.id)).toEqual([playable]);

    // Still liked, though — the membership is intact and `GET /api/library`
    // says so. A client that hid the like button would be wrong.
    expect(await call(getUserLibrary, { userId: USER }).then((res) => res._body)).toMatchObject({
      likedTracks: [playable, removed, unavailable],
    });
  });
});

describe('recently played', () => {
  it('records a play, dedupes a replay, and returns it newest first', async () => {
    const [a, b] = [await makeTrack(), await makeTrack()];

    await call(recordRecentlyPlayed, { body: { trackId: a }, userId: USER });
    await call(recordRecentlyPlayed, { body: { trackId: b }, userId: USER });
    // Within the 30s dedup window: refreshes the row rather than stacking one.
    await call(recordRecentlyPlayed, { body: { trackId: a }, userId: USER });

    expect((await getDb().select().from(recentlyPlayed)).length).toBe(2);

    const res = await call(getRecentlyPlayed, { userId: USER });
    const body = res._body as { tracks: { id: string }[] };
    expect(body.tracks.map((track) => track.id)).toEqual([a, b]);
  });

  it('rejects a malformed track id with a 400 and an unknown one with a 404', async () => {
    // Two different failures with two different answers: the first never
    // reaches the database, the second is the foreign key.
    expect((await call(recordRecentlyPlayed, { body: { trackId: 'nope' }, userId: USER }))._status)
      .toBe(400);
    expect((await call(recordRecentlyPlayed, { body: { trackId: uuidv7() }, userId: USER }))._status)
      .toBe(404);
    expect((await call(recordRecentlyPlayed, { body: {}, userId: USER }))._status).toBe(400);

    expect((await getDb().select().from(recentlyPlayed)).length).toBe(0);
  });

  it('omits a played track that is no longer playable', async () => {
    const removed = await makeTrack({ copyrightRemoved: true });
    await call(recordRecentlyPlayed, { body: { trackId: removed }, userId: USER });

    const res = await call(getRecentlyPlayed, { userId: USER });
    expect(res._body).toEqual({ tracks: [] });
  });
});
