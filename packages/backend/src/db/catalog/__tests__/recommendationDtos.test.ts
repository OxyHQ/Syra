import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { uuidv7 } from '@oxyhq/db';
import { connect, clear, disconnect } from '../../../test/mongo';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { albums, catalogEntities, imageAssets, tracks } from '../../schema/catalog';
import {
  getRelatedArtistsHandler,
  getSimilarTracksHandler,
} from '../../../controllers/recommendations.controller';

/**
 * The recommendation surfaces return a DTO with CONTENT, not a shell.
 *
 * ## The bug this exists for
 *
 * `recommendationService` moved to drizzle and kept two hand-written ranking
 * projections; both controllers went on passing the result to
 * `formatTracksWithCoverArt(tracks: any[])` / `formatArtistsWithImage(artists:
 * any[])`. Those destructure `_id`, which a drizzle row does not have, so every
 * response was:
 *
 *     {"id":"","artistId":"…","genre":"rock","popularity":42, …}
 *
 * — `id` an empty string, and no `title`, `artistName`, `name` or cover art at
 * all. Four live endpoints (`/api/artists/:id/related`, `/api/tracks/:id/similar`,
 * `/api/recommendations/made-for-you`, `/api/browse/made-for-you`) answered that
 * shape, `tsc` was clean, and no test went red — the `any` on both ends is
 * exactly what made it invisible.
 *
 * ## Why the assertions look the way they do
 *
 * Every one names a field and asserts the VALUE the fixture wrote. A shape
 * assertion — `toHaveProperty('id')`, `Array.isArray`, a length check, or
 * `toBeDefined()` — passes against `{"id":""}`, which is the defect wearing a
 * test. `id` in particular is asserted equal to the seeded uuid rather than
 * merely truthy, because `''` is the exact value the bug produced.
 *
 * Mutation-verified, and stated as MEASURED rather than as intended: reverting
 * both controller lines to the Mongo formatters (with a cast, since the typed
 * parameter is now itself a compile-time guard) fails both tests — on the `id`
 * equality, which is the FIRST assertion and short-circuits the rest. The
 * `name` / `title` / `coverArt` assertions below are therefore not what catches
 * THIS mutation; they catch a serializer that keeps the id and drops a field,
 * which is a different regression and the reason they name values rather than
 * check shape.
 *
 * BOTH databases: the catalogue is Postgres, while the co-listen graph
 * (`CatalogRelation`) belongs to Task 15 and is still Mongoose. Neither handler
 * under test needs an edge — both fall back to genre/popularity, which is the
 * path a sparse catalogue actually takes — but the model is loaded, so the
 * connection has to exist.
 */

beforeAll(async () => {
  await connect();
  await connectDb();
});
afterEach(async () => {
  await clear();
  await clearDb();
});
afterAll(async () => {
  await disconnect();
  await disconnectDb();
});

// ── Fake req/res ──────────────────────────────────────────────────────────

interface CapturedRes {
  _status: number;
  _body: unknown;
  status(code: number): CapturedRes;
  set(name: string, value: string): CapturedRes;
  json(body: unknown): CapturedRes;
}

function makeRes(): CapturedRes {
  return {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    set() { return this; },
    json(body) { this._body = body; return this; },
  };
}

function makeReq(params: Record<string, string>): AuthRequest {
  return { params, query: {}, user: undefined } as unknown as AuthRequest;
}

const next: NextFunction = (err?: unknown) => {
  if (err) throw err;
};

// ── Fixtures ──────────────────────────────────────────────────────────────

const GENRE = 'shoegaze';

async function makeImageAsset(ownerType: 'album' | 'artist' | 'track'): Promise<string> {
  const [asset] = await getDb()
    .insert(imageAssets)
    .values({
      s3Key: `fixtures/${uuidv7()}.jpg`,
      filename: 'cover.jpg',
      contentType: 'image/jpeg',
      byteSize: 1,
      // Dimensions are required for a variant to render — `imageVariantLookup`
      // drops an asset carrying none, so a fixture without them would make the
      // image assertions below fail for a reason that is not the bug.
      width: 640,
      height: 640,
      ownerType,
    })
    .returning({ id: imageAssets.id });

  if (!asset) throw new Error('makeImageAsset: insert returned no row');
  return asset.id;
}

async function makeArtist(name: string): Promise<string> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name,
      // `catalog_entities_artist_name_key_key` is a unique partial index.
      nameKey: `artist-${suffix}`,
      source: 'upload',
      genres: [GENRE],
      popularity: 80,
      imageId: await makeImageAsset('artist'),
    })
    .returning({ id: catalogEntities.id });

  if (!artist) throw new Error('makeArtist: insert returned no row');
  return artist.id;
}

async function makeAlbum(artistId: string, artistName: string): Promise<string> {
  const [album] = await getDb()
    .insert(albums)
    .values({
      title: `${artistName} — an album`,
      artistId,
      artistName,
      releaseDate: '1991-11-04',
      coverArtId: await makeImageAsset('album'),
    })
    .returning({ id: albums.id });

  if (!album) throw new Error('makeAlbum: insert returned no row');
  return album.id;
}

async function makeTrack(
  title: string,
  artistId: string,
  artistName: string,
  albumId: string
): Promise<string> {
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title,
      artistId,
      artistName,
      albumId,
      albumName: 'an album',
      duration: 221.5,
      genre: GENRE,
      source: 'upload',
      status: 'ready',
      popularity: 70,
      coverArtId: await makeImageAsset('track'),
    })
    .returning({ id: tracks.id });

  if (!track) throw new Error('makeTrack: insert returned no row');
  return track.id;
}

// ── GET /api/artists/:id/related ──────────────────────────────────────────

describe('getRelatedArtistsHandler', () => {
  it('returns artists carrying their real id, name and image', async () => {
    const seedId = await makeArtist('Seed Artist');
    const relatedId = await makeArtist('Slowdive');

    // `getRelatedArtists` ends in `withPlayableCatalog`, which drops an artist
    // with nothing left to play — so the related artist needs a real track or
    // the handler correctly returns nothing and the test measures the wrong
    // thing.
    await makeTrack('Alison', relatedId, 'Slowdive', await makeAlbum(relatedId, 'Slowdive'));

    const res = makeRes();
    await getRelatedArtistsHandler(makeReq({ id: seedId }), res as unknown as Response, next);

    const body = res._body as { artists: { id: string; name: string; image?: string }[] };

    // Vacuity floor: the fallback really did find the other artist. Without
    // this, every field assertion below would pass over an empty array.
    expect(body.artists.map((artist) => artist.id)).toEqual([relatedId]);

    const [artist] = body.artists;
    if (!artist) throw new Error('unreachable: the id assertion above proves one artist');

    // The three fields the bug dropped. `id` is compared to the seeded uuid
    // because the bug's value was `''`, which every truthiness check accepts.
    expect(artist.id).toBe(relatedId);
    expect(artist.name).toBe('Slowdive');
    expect(artist.image).toMatch(/^\/api\/images\/[0-9a-f-]{36}$/);
  });
});

// ── GET /api/tracks/:id/similar ───────────────────────────────────────────

describe('getSimilarTracksHandler', () => {
  it('returns tracks carrying their real id, title, artist name and cover art', async () => {
    const artistId = await makeArtist('My Bloody Valentine');
    const albumId = await makeAlbum(artistId, 'My Bloody Valentine');
    const seedTrackId = await makeTrack('Only Shallow', artistId, 'My Bloody Valentine', albumId);
    const similarTrackId = await makeTrack('Soon', artistId, 'My Bloody Valentine', albumId);

    const res = makeRes();
    await getSimilarTracksHandler(makeReq({ id: seedTrackId }), res as unknown as Response, next);

    const body = res._body as {
      tracks: { id: string; title: string; artistName: string; duration: number; coverArt?: string }[];
    };

    // Vacuity floor, and it also pins the seed exclusion: the only similar
    // track is the OTHER one.
    expect(body.tracks.map((track) => track.id)).toEqual([similarTrackId]);

    const [track] = body.tracks;
    if (!track) throw new Error('unreachable: the id assertion above proves one track');

    expect(track.id).toBe(similarTrackId);
    expect(track.title).toBe('Soon');
    expect(track.artistName).toBe('My Bloody Valentine');
    expect(track.duration).toBe(221.5);
    expect(track.coverArt).toMatch(/^\/api\/images\/[0-9a-f-]{36}$/);
  });
});
