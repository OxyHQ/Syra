import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { uuidv7 } from '@oxyhq/db';
import { PlaylistVisibility } from '@syra/shared-types';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, imageAssets, tracks } from '../db/schema/catalog';
import { playlistCollaborators, playlists } from '../db/schema/library';
import {
  addTracksToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylistById,
  getPlaylistTracks,
  getUserPlaylists,
  removeTracksFromPlaylist,
  reorderPlaylistTracks,
  updatePlaylist,
} from './playlists.controller';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { NextFunction, Response } from 'express';

/**
 * The playlists API on Postgres.
 *
 * What this file is FOR, over and above `db/library/__tests__/playlists.test.ts`
 * (which owns the queries): the handler-level decisions the port changed, each
 * of which is a wire-visible behaviour nothing else asserts —
 *
 *  - a cover art id is now validated with `isLiveEntityId` rather than
 *    `mongoose.Types.ObjectId.isValid`, which rejected every uuid v7 the image
 *    service has minted since the cutover;
 *  - an unknown cover art is a 400 rather than an unhandled `23503`;
 *  - `position` is clamped into the playlist instead of writing a gap or `NaN`;
 *  - a request naming the same track twice adds it once;
 *  - a reorder that names only part of the playlist is well defined.
 */

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const OWNER = 'oxy-owner';
const STRANGER = 'oxy-stranger';

interface CapturedRes {
  _status: number;
  _body: unknown;
  status(code: number): CapturedRes;
  json(body: unknown): CapturedRes;
  send(): CapturedRes;
}

function makeRes(): CapturedRes {
  return {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send() { return this; },
  };
}

function makeReq(
  over: { params?: Record<string, string>; body?: unknown; userId?: string; username?: string } = {}
): AuthRequest {
  return {
    params: over.params ?? {},
    query: {},
    body: over.body ?? {},
    user: over.userId ? { id: over.userId, username: over.username } : undefined,
  } as unknown as AuthRequest;
}

const next: NextFunction = (err?: unknown) => {
  if (err) throw err;
};

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

async function makeImageAsset(primaryColor?: string): Promise<string> {
  const id = uuidv7();
  await getDb().insert(imageAssets).values({
    id,
    s3Key: `k/${id}`,
    filename: 'c.jpg',
    contentType: 'image/jpeg',
    byteSize: 1,
    ownerType: 'playlist',
    primaryColor,
  });
  return id;
}

/** Create a playlist through the handler and return its id. */
async function createThrough(body: Record<string, unknown>, userId = OWNER): Promise<CapturedRes> {
  const res = makeRes();
  // `createPlaylist` takes a `PlaylistAuthRequest`, whose `user` is narrower
  // than `OxyAuthRequest`'s (no `null`), so the fake goes in through the same
  // cast the other helpers use.
  const req = makeReq({ body, userId, username: 'owner' }) as unknown as Parameters<
    typeof createPlaylist
  >[0];
  await createPlaylist(req, res as unknown as Response, next);
  return res;
}

function bodyId(res: CapturedRes): string {
  const body = res._body as { id?: string } | undefined;
  if (!body?.id) throw new Error(`expected an id in the response, got ${JSON.stringify(res._body)}`);
  return body.id;
}

describe('POST /api/playlists', () => {
  it('creates a private playlist by default and names its owner', async () => {
    const res = await createThrough({ name: '  Late night  ' });

    expect(res._status).toBe(201);
    expect(res._body).toMatchObject({
      name: 'Late night',
      ownerOxyUserId: OWNER,
      ownerUsername: 'owner',
      visibility: PlaylistVisibility.PRIVATE,
      trackCount: 0,
      totalDuration: 0,
    });
  });

  /**
   * The live defect this port fixes.
   *
   * `services/imageAssetService.ts` mints a uuid v7 for every uploaded image,
   * and the guard here was `mongoose.Types.ObjectId.isValid` — which accepts
   * only a 24-char hex string. Every real cover art id was therefore a 400.
   */
  it('accepts a uuid v7 cover art id, which the ObjectId guard rejected', async () => {
    const coverArtId = await makeImageAsset('#ff0000');
    const res = await createThrough({ name: 'With art', coverArt: coverArtId });

    expect(res._status).toBe(201);
    expect(res._body).toMatchObject({
      coverArt: `/api/images/${coverArtId}`,
      primaryColor: '#ff0000',
    });
  });

  it('rejects a URL where an image id belongs', async () => {
    for (const coverArt of ['blob:whatever', 'http://x/y.jpg', 'https://x/y.jpg', '/api/images/x']) {
      const res = await createThrough({ name: 'Bad art', coverArt });
      expect(`${coverArt} -> ${res._status}`).toBe(`${coverArt} -> 400`);
    }
  });

  /**
   * `cover_art_id` is a real foreign key, so a well-formed id naming no image
   * is `23503`. Answered as a 400 about the field the client sent rather than
   * reaching the error handler as a 500.
   *
   * The image in the OTHER assertion carries NO `primary_color`, which is the
   * fixture that matters: `getStoredImageColors` returns `undefined` for a
   * missing image AND for one with no palette, so an existence check built on
   * it would reject this perfectly good cover.
   */
  it('rejects a well-formed cover art id naming no image', async () => {
    const res = await createThrough({ name: 'Ghost art', coverArt: uuidv7() });
    expect(res._status).toBe(400);
  });

  it('accepts an image that exists but has no extracted palette', async () => {
    const coverArtId = await makeImageAsset(undefined);
    const res = await createThrough({ name: 'Palette-less', coverArt: coverArtId });

    expect(res._status).toBe(201);
    expect(res._body).toMatchObject({ coverArt: `/api/images/${coverArtId}` });
  });

  it('rejects an empty name and an invalid visibility', async () => {
    expect((await createThrough({ name: '   ' }))._status).toBe(400);
    expect((await createThrough({ name: 'Mix', visibility: 'semi-public' }))._status).toBe(400);
  });
});

describe('GET /api/playlists/:id', () => {
  it('serves a public playlist to a stranger and to nobody at all', async () => {
    const id = bodyId(await createThrough({ name: 'Public', visibility: 'public' }));

    for (const viewer of [STRANGER, undefined]) {
      const res = makeRes();
      await getPlaylistById(
        makeReq({ params: { id }, userId: viewer }),
        res as unknown as Response,
        next
      );
      expect(`${viewer ?? 'anon'}: ${res._status}`).toBe(`${viewer ?? 'anon'}: 200`);
    }
  });

  it('refuses a private playlist to a stranger, and a playlist that does not exist', async () => {
    const id = bodyId(await createThrough({ name: 'Private' }));

    const forbidden = makeRes();
    await getPlaylistById(
      makeReq({ params: { id }, userId: STRANGER }),
      forbidden as unknown as Response,
      next
    );
    expect(forbidden._status).toBe(403);

    // A missing playlist is 403 too, and always has been — a 404 would tell a
    // stranger which private playlist ids are real.
    const missing = makeRes();
    await getPlaylistById(
      makeReq({ params: { id: uuidv7() }, userId: STRANGER }),
      missing as unknown as Response,
      next
    );
    expect(missing._status).toBe(403);
  });

  it('serves a private playlist to a collaborator of any role', async () => {
    const id = bodyId(await createThrough({ name: 'Private' }));
    await getDb().insert(playlistCollaborators).values({
      playlistId: id,
      oxyUserId: STRANGER,
      username: 'guest',
      role: 'viewer',
      addedAt: new Date(),
    });

    const res = makeRes();
    await getPlaylistById(
      makeReq({ params: { id }, userId: STRANGER }),
      res as unknown as Response,
      next
    );

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({
      collaborators: [{ oxyUserId: STRANGER, username: 'guest', role: 'viewer' }],
    });
  });
});

describe('PUT /api/playlists/:id', () => {
  it('clears the cover art and its colours together', async () => {
    const id = bodyId(
      await createThrough({ name: 'Mix', coverArt: await makeImageAsset('#00ff00') })
    );

    const res = makeRes();
    await updatePlaylist(
      makeReq({ params: { id }, body: { coverArt: null }, userId: OWNER }),
      res as unknown as Response,
      next
    );

    expect(res._status).toBe(200);
    const body = res._body as { coverArt?: string; primaryColor?: string };
    expect(`${body.coverArt}/${body.primaryColor}`).toBe('undefined/undefined');
  });

  it('accepts a body naming no writable field', async () => {
    // drizzle rejects an empty `set()` rather than treating it as a no-op, so
    // this is a 500 unless the handler answers it without an UPDATE.
    const id = bodyId(await createThrough({ name: 'Mix' }));

    const res = makeRes();
    await updatePlaylist(
      makeReq({ params: { id }, body: {}, userId: OWNER }),
      res as unknown as Response,
      next
    );

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ name: 'Mix' });
  });

  it('refuses a stranger', async () => {
    const id = bodyId(await createThrough({ name: 'Mix' }));

    const res = makeRes();
    await updatePlaylist(
      makeReq({ params: { id }, body: { name: 'Theirs' }, userId: STRANGER }),
      res as unknown as Response,
      next
    );

    expect(res._status).toBe(403);
  });
});

describe('POST /api/playlists/:id/tracks', () => {
  async function tracksOf(id: string, userId = OWNER): Promise<string[]> {
    const res = makeRes();
    await getPlaylistTracks(
      makeReq({ params: { id }, userId }),
      res as unknown as Response,
      next
    );
    const body = res._body as { tracks: { id: string }[] };
    return body.tracks.map((track) => track.id);
  }

  it('appends by default and keeps the stats in step', async () => {
    const id = bodyId(await createThrough({ name: 'Mix' }));
    const [a, b] = [await makeTrack(), await makeTrack()];

    const res = makeRes();
    await addTracksToPlaylist(
      makeReq({ params: { id }, body: { trackIds: [a, b] }, userId: OWNER }),
      res as unknown as Response,
      next
    );

    expect(res._status).toBe(201);
    expect(res._body).toEqual({ added: 2, skipped: 0 });
    expect(await tracksOf(id)).toEqual([a, b]);

    const detail = makeRes();
    await getPlaylistById(makeReq({ params: { id }, userId: OWNER }), detail as unknown as Response, next);
    expect(detail._body).toMatchObject({ trackCount: 2, totalDuration: 400 });
  });

  it('inserts at a position, shifting the tracks already there', async () => {
    const id = bodyId(await createThrough({ name: 'Mix' }));
    const [a, b, c] = [await makeTrack(), await makeTrack(), await makeTrack()];
    await addTracksToPlaylist(
      makeReq({ params: { id }, body: { trackIds: [a, b] }, userId: OWNER }),
      makeRes() as unknown as Response,
      next
    );

    // Position 0 on a two-track playlist: the Mongo `$inc` shift this replaced
    // is a duplicate-key error against `unique(playlist_id, position)`.
    await addTracksToPlaylist(
      makeReq({ params: { id }, body: { trackIds: [c], position: 0 }, userId: OWNER }),
      makeRes() as unknown as Response,
      next
    );

    expect(await tracksOf(id)).toEqual([c, a, b]);
  });

  /**
   * The Mongo version used `position` verbatim, so a value past the end left a
   * GAP in the ordering and a non-numeric one wrote `NaN`. Both are clamped
   * into the playlist now — positions are `0…n-1`, which is what the removal
   * path already assumed.
   */
  it('clamps a position past the end and a non-numeric one', async () => {
    const id = bodyId(await createThrough({ name: 'Mix' }));
    const [a, b, c] = [await makeTrack(), await makeTrack(), await makeTrack()];
    await addTracksToPlaylist(
      makeReq({ params: { id }, body: { trackIds: [a] }, userId: OWNER }),
      makeRes() as unknown as Response,
      next
    );

    await addTracksToPlaylist(
      makeReq({ params: { id }, body: { trackIds: [b], position: 999 }, userId: OWNER }),
      makeRes() as unknown as Response,
      next
    );
    await addTracksToPlaylist(
      makeReq({ params: { id }, body: { trackIds: [c], position: 'abc' }, userId: OWNER }),
      makeRes() as unknown as Response,
      next
    );

    expect(await tracksOf(id)).toEqual([a, b, c]);
  });

  it('adds a track named twice in one request exactly once', async () => {
    const id = bodyId(await createThrough({ name: 'Mix' }));
    const a = await makeTrack();

    const res = makeRes();
    await addTracksToPlaylist(
      makeReq({ params: { id }, body: { trackIds: [a, a] }, userId: OWNER }),
      res as unknown as Response,
      next
    );

    expect(res._body).toEqual({ added: 1, skipped: 1 });
    expect(await tracksOf(id)).toEqual([a]);
  });

  it('refuses tracks that do not exist, and skips ones already present', async () => {
    const id = bodyId(await createThrough({ name: 'Mix' }));
    const a = await makeTrack();

    const missing = makeRes();
    await addTracksToPlaylist(
      makeReq({ params: { id }, body: { trackIds: [uuidv7()] }, userId: OWNER }),
      missing as unknown as Response,
      next
    );
    expect(missing._status).toBe(404);

    await addTracksToPlaylist(
      makeReq({ params: { id }, body: { trackIds: [a] }, userId: OWNER }),
      makeRes() as unknown as Response,
      next
    );
    const again = makeRes();
    await addTracksToPlaylist(
      makeReq({ params: { id }, body: { trackIds: [a] }, userId: OWNER }),
      again as unknown as Response,
      next
    );
    expect(again._status).toBe(400);
  });
});

describe('DELETE and reorder', () => {
  async function seedThree(): Promise<{ id: string; ids: string[] }> {
    const id = bodyId(await createThrough({ name: 'Mix' }));
    const ids = [await makeTrack(), await makeTrack(), await makeTrack()];
    await addTracksToPlaylist(
      makeReq({ params: { id }, body: { trackIds: ids }, userId: OWNER }),
      makeRes() as unknown as Response,
      next
    );
    return { id, ids };
  }

  async function orderOf(id: string): Promise<number[]> {
    const res = makeRes();
    await getPlaylistTracks(makeReq({ params: { id }, userId: OWNER }), res as unknown as Response, next);
    const body = res._body as { playlistTracks: { order: number }[] };
    return body.playlistTracks.map((entry) => entry.order);
  }

  it('removing a middle track closes the gap it leaves', async () => {
    const { id, ids } = await seedThree();

    const res = makeRes();
    await removeTracksFromPlaylist(
      makeReq({ params: { id }, body: { trackIds: [ids[1]] }, userId: OWNER }),
      res as unknown as Response,
      next
    );

    expect(res._body).toEqual({ removed: 1 });
    expect(await orderOf(id)).toEqual([0, 1]);
  });

  it('reverses a playlist, which no single UPDATE could do', async () => {
    const { id, ids } = await seedThree();

    const res = makeRes();
    await reorderPlaylistTracks(
      makeReq({ params: { id }, body: { trackIds: [...ids].reverse() }, userId: OWNER }),
      res as unknown as Response,
      next
    );

    expect(res._body).toEqual({ reordered: 3 });
    const detail = makeRes();
    await getPlaylistTracks(makeReq({ params: { id }, userId: OWNER }), detail as unknown as Response, next);
    const body = detail._body as { tracks: { id: string }[] };
    expect(body.tracks.map((track) => track.id)).toEqual([...ids].reverse());
  });

  /**
   * A partial reorder. The Mongo version left the unnamed rows at whatever
   * position they already held, which collides with a newly assigned one; here
   * they keep their relative order AFTER the named ones.
   */
  it('puts the tracks a partial reorder did not name after the ones it did', async () => {
    const { id, ids } = await seedThree();

    await reorderPlaylistTracks(
      makeReq({ params: { id }, body: { trackIds: [ids[2]] }, userId: OWNER }),
      makeRes() as unknown as Response,
      next
    );

    const detail = makeRes();
    await getPlaylistTracks(makeReq({ params: { id }, userId: OWNER }), detail as unknown as Response, next);
    const body = detail._body as { tracks: { id: string }[] };
    expect(body.tracks.map((track) => track.id)).toEqual([ids[2], ids[0], ids[1]]);
  });

  it('refuses a reorder naming a track the playlist does not hold', async () => {
    const { id, ids } = await seedThree();
    const outsider = await makeTrack();

    const res = makeRes();
    await reorderPlaylistTracks(
      makeReq({ params: { id }, body: { trackIds: [...ids, outsider] }, userId: OWNER }),
      res as unknown as Response,
      next
    );

    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ invalidTrackIds: [outsider] });
  });

  it('deleting a playlist takes its tracks and collaborators with it', async () => {
    const { id } = await seedThree();
    await getDb().insert(playlistCollaborators).values({
      playlistId: id,
      oxyUserId: STRANGER,
      username: 'guest',
      role: 'viewer',
      addedAt: new Date(),
    });

    const res = makeRes();
    await deletePlaylist(makeReq({ params: { id }, userId: OWNER }), res as unknown as Response, next);
    expect(res._status).toBe(204);

    expect(await getDb().select().from(playlists)).toEqual([]);
    expect(await getDb().select().from(playlistCollaborators)).toEqual([]);
  });

  it('refuses a delete from a collaborator who is not the owner', async () => {
    const { id } = await seedThree();
    await getDb().insert(playlistCollaborators).values({
      playlistId: id,
      oxyUserId: STRANGER,
      username: 'guest',
      role: 'editor',
      addedAt: new Date(),
    });

    const res = makeRes();
    await deletePlaylist(makeReq({ params: { id }, userId: STRANGER }), res as unknown as Response, next);
    expect(res._status).toBe(403);
  });
});

describe('GET /api/playlists', () => {
  it('lists what the caller owns and collaborates on, and nothing else', async () => {
    const owned = bodyId(await createThrough({ name: 'Owned' }));
    const theirs = bodyId(await createThrough({ name: 'Theirs' }, STRANGER));
    await getDb().insert(playlistCollaborators).values({
      playlistId: theirs,
      oxyUserId: OWNER,
      username: 'owner',
      role: 'editor',
      addedAt: new Date(),
    });
    await createThrough({ name: 'Unrelated' }, STRANGER);

    const res = makeRes();
    await getUserPlaylists(makeReq({ userId: OWNER }), res as unknown as Response, next);

    const body = res._body as { playlists: { id: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.playlists.map((playlist) => playlist.id).sort()).toEqual([owned, theirs].sort());
  });

  it('requires auth', async () => {
    const res = makeRes();
    await getUserPlaylists(makeReq(), res as unknown as Response, next);
    expect(res._status).toBe(401);
  });
});
