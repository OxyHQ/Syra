import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { PlaylistVisibility, normalizeNameKey } from '@syra/shared-types';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { albums, catalogEntities, imageAssets, tracks } from '../db/schema/catalog';
import { playlistTracks, playlists } from '../db/schema/library';
import { getGenres, getHomeBrowse, getMadeForYou, getPopularAlbums, getPopularTracks } from './browse.controller';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { Request, Response, NextFunction } from 'express';

/**
 * Postgres only. Every read in `browse.controller` is drizzle now, and the
 * personalised branch is not exercised here — these are the GUEST surfaces, so
 * nothing in this file reaches `recommendationService`'s Mongo half.
 */
beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

// ── Fake req/res helpers ──────────────────────────────────────────────────────

interface CapturedRes {
  _status: number;
  _body: unknown;
  _headers: Record<string, string>;
  status(code: number): CapturedRes;
  set(name: string, value: string): CapturedRes;
  json(body: unknown): CapturedRes;
}

function makeRes(): CapturedRes {
  return {
    _status: 200,
    _body: undefined,
    _headers: {},
    status(code) { this._status = code; return this; },
    set(name, value) { this._headers[name] = value; return this; },
    json(body) { this._body = body; return this; },
  };
}

function makeReq(query: Record<string, string> = {}, userId?: string): Request {
  return {
    query,
    user: userId ? { id: userId } : undefined,
  } as unknown as AuthRequest;
}

const next: NextFunction = (err?: unknown) => {
  if (err) throw err;
};

// ── Seed helpers ───────────────────────────────────────────────────────────────

/**
 * ONE artist per file, minted lazily.
 *
 * `tracks.artist_id` and `albums.artist_id` are real foreign keys to
 * `catalog_entities`, so the Mongo fixtures' hard-coded `'507f…011'` is no
 * longer insertable at all — every seed has to hang off a row that exists.
 */
let artistId: string | undefined;

async function theArtist(): Promise<string> {
  if (artistId) return artistId;
  const name = `An Artist ${uuidv7()}`;
  const [row] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name,
      nameKey: normalizeNameKey(name),
      source: 'cc',
      popularity: 0,
    })
    .returning({ id: catalogEntities.id });
  if (!row) throw new Error('theArtist: insert returned no row');
  artistId = row.id;
  return artistId;
}

afterEach(() => {
  // `clearDb` truncates, so the cached id no longer names a row.
  artistId = undefined;
});

/** A stored image asset, because `albums.cover_art_id` is a NOT NULL foreign key. */
async function seedCoverArt(): Promise<string> {
  const id = uuidv7();
  await getDb().insert(imageAssets).values({
    id,
    s3Key: `covers/${id}.jpg`,
    filename: 'cover.jpg',
    contentType: 'image/jpeg',
    byteSize: 1000,
    width: 640,
    height: 640,
    ownerType: 'album',
  });
  return id;
}

type TrackOverrides = Partial<typeof tracks.$inferInsert>;

async function seedTrack(overrides: TrackOverrides = {}): Promise<string> {
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: 'A Track',
      artistId: await theArtist(),
      artistName: 'An Artist',
      duration: 180,
      source: 'cc',
      status: 'ready',
      isExplicit: false,
      isAvailable: true,
      ...overrides,
    })
    .returning({ id: tracks.id });
  if (!track) throw new Error('seedTrack: insert returned no row');
  return track.id;
}

async function seedAlbum(
  overrides: Partial<typeof albums.$inferInsert> = {}
): Promise<string> {
  const [album] = await getDb()
    .insert(albums)
    .values({
      title: 'An Album',
      artistId: await theArtist(),
      artistName: 'An Artist',
      releaseDate: '2021-01-01',
      coverArtId: await seedCoverArt(),
      ...overrides,
    })
    .returning({ id: albums.id });
  if (!album) throw new Error('seedAlbum: insert returned no row');
  return album.id;
}

async function seedPlaylistWithTrack(
  playlistName: string,
  trackOverrides: TrackOverrides = {},
  playlistOverrides: Partial<typeof playlists.$inferInsert> = {},
): Promise<void> {
  const [playlist] = await getDb()
    .insert(playlists)
    .values({
      name: playlistName,
      ownerOxyUserId: 'system:test',
      ownerUsername: 'Test',
      visibility: PlaylistVisibility.PUBLIC,
      trackCount: 1,
      totalDuration: 180,
      followers: 0,
      source: trackOverrides.source,
      ...playlistOverrides,
    })
    .returning({ id: playlists.id });
  if (!playlist) throw new Error('seedPlaylistWithTrack: playlist insert returned no row');

  const trackId = await seedTrack({ title: `${playlistName} Track`, ...trackOverrides });

  await getDb().insert(playlistTracks).values({
    playlistId: playlist.id,
    trackId,
    addedAt: new Date('2026-01-01T00:00:00.000Z'),
    position: 0,
  });
}

// ── getGenres ───────────────────────────────────────────────────────────────

describe('getGenres', () => {
  it('surfaces genres from tracks even when no albums exist', async () => {
    await seedTrack({ genre: 'Electronic', playCount: 1000, popularity: 50 });
    await seedTrack({ genre: 'House', playCount: 10 });

    const res = makeRes();
    await getGenres(makeReq(), res as unknown as Response, next);

    expect(res._status).toBe(200);
    const body = res._body as { genres: Array<{ name: string }> };
    const names = body.genres.map((g) => g.name).sort();
    expect(names).toEqual(['Electronic', 'House']);
  });

  /**
   * The Mongo version filtered its `distinct('genre')` result with
   * `.filter(Boolean)`, which drops `null` AND `''`. The port's `where` has to
   * do both, and `is not null` alone does not — an empty-string genre is a row
   * with a value. That is the only input shape making the two spellings
   * disagree, so it is seeded here; without it, dropping `ne(genre, '')` leaves
   * this suite green while a blank card appears on the browse screen.
   */
  it('ignores a track whose genre is an empty string', async () => {
    await seedTrack({ genre: 'Electronic' });
    await seedTrack({ genre: '' });

    const res = makeRes();
    await getGenres(makeReq(), res as unknown as Response, next);

    const body = res._body as { genres: Array<{ name: string }> };
    expect(body.genres.map((g) => g.name)).toEqual(['Electronic']);
  });

  it('only surfaces genres backed by playable tracks', async () => {
    await seedTrack({ genre: 'Electronic' });
    // A copyright-removed track in another genre must not produce a card.
    await seedTrack({ genre: 'Jazz', copyrightRemoved: true, isAvailable: false });
    // Nor must an album's genre, which is a different table entirely.
    await seedAlbum({ title: 'Album Genre' });

    const res = makeRes();
    await getGenres(makeReq(), res as unknown as Response, next);

    const body = res._body as { genres: Array<{ name: string }> };
    const names = body.genres.map((g) => g.name).sort();
    expect(names).toEqual(['Electronic']);
  });

  /**
   * `images` is a server-only column (`PROTECTED_COLUMNS_BY_TABLE`), so its
   * external URLs cannot reach a card even by accident. The Mongo version of
   * this test guarded a `delete` in `stripExternalCatalogFields`; the guard here
   * is that `normalizeImageRef` only ever answers `/api/images/:id`.
   */
  it('does not use track images[] external URLs as genre cover art', async () => {
    await seedTrack({
      genre: 'Electronic',
      images: [{ url: 'https://cdn/track-art.jpg', width: 1000, height: 1000, source: 'cc' }],
    });

    const res = makeRes();
    await getGenres(makeReq(), res as unknown as Response, next);

    const body = res._body as { genres: Array<{ name: string; coverArt: string | null }> };
    const electronic = body.genres.find((g) => g.name === 'Electronic');
    // Present as an explicit null rather than dropped — the contract is
    // `string | null`, and `res.json` would omit an `undefined`.
    expect(electronic).toBeDefined();
    expect(electronic?.coverArt).toBeNull();
  });

  it('prefers a sample track that HAS cover art', async () => {
    const coverArtId = await seedCoverArt();
    // Higher popularity, no cover — it would win on popularity alone.
    await seedTrack({ genre: 'Electronic', title: 'Coverless', popularity: 90 });
    await seedTrack({ genre: 'Electronic', title: 'Illustrated', popularity: 10, coverArtId });

    const res = makeRes();
    await getGenres(makeReq(), res as unknown as Response, next);

    const body = res._body as { genres: Array<{ name: string; coverArt: string | null }> };
    expect(body.genres.find((g) => g.name === 'Electronic')?.coverArt).toBe(
      `/api/images/${coverArtId}`
    );
  });
});

// ── getPopularTracks ──────────────────────────────────────────────────────────

describe('getPopularTracks', () => {
  it('orders by popularity/playCount descending', async () => {
    await seedTrack({ title: 'Low', playCount: 10, popularity: 5 });
    await seedTrack({ title: 'High', playCount: 100000, popularity: 80 });
    await seedTrack({ title: 'Mid', playCount: 5000, popularity: 40 });

    const res = makeRes();
    await getPopularTracks(makeReq(), res as unknown as Response, next);

    const body = res._body as { tracks: Array<{ title: string }> };
    expect(body.tracks.map((t) => t.title)).toEqual(['High', 'Mid', 'Low']);
  });
});

// ── getPopularAlbums ─────────────────────────────────────────────────────────

describe('getPopularAlbums', () => {
  it('excludes albums whose only tracks are not playable', async () => {
    const playableAlbum = await seedAlbum({ title: 'Playable Album', popularity: 80 });
    const unplayableAlbum = await seedAlbum({ title: 'Unplayable Album', popularity: 99 });
    await seedTrack({ title: 'Available', albumId: playableAlbum, popularity: 80 });
    // Higher popularity, so it would sort FIRST if it were not filtered out.
    await seedTrack({
      title: 'Taken Down',
      albumId: unplayableAlbum,
      popularity: 99,
      copyrightRemoved: true,
    });

    const res = makeRes();
    await getPopularAlbums(makeReq(), res as unknown as Response, next);

    const body = res._body as { albums: Array<{ title: string }> };
    expect(body.albums.map((album) => album.title)).toEqual(['Playable Album']);
  });
});

// ── getHomeBrowse ───────────────────────────────────────────────────────────

describe('getHomeBrowse', () => {
  it('does not surface playlists whose only tracks are not playable', async () => {
    await seedPlaylistWithTrack(
      'Unplayable Playlist',
      { isAvailable: false },
      { followers: 100 },
    );
    await seedPlaylistWithTrack('Playable Playlist', {}, { followers: 1 });

    const res = makeRes();
    await getHomeBrowse(makeReq({ sectionLimit: '4', tracksLimit: '4' }), res as unknown as Response, next);

    const body = res._body as { madeForYou: { playlists: Array<{ name: string }> } };
    expect(body.madeForYou.playlists.map((playlist) => playlist.name)).toEqual(['Playable Playlist']);
  });
});

// ── getMadeForYou ─────────────────────────────────────────────────────────────

describe('getMadeForYou', () => {
  it('excludes playlists with no playable tracks from public discovery', async () => {
    await seedPlaylistWithTrack('Unplayable Playlist', { isAvailable: false });

    const res = makeRes();
    await getMadeForYou(makeReq(), res as unknown as Response, next);

    const body = res._body as { playlists: Array<{ name: string }> };
    expect(body.playlists).toHaveLength(0);
  });

  it('falls back to popular tracks + artists when albums/playlists are sparse', async () => {
    const id = await theArtist();
    await seedTrack({ title: 'Popular', playCount: 100000, popularity: 80 });
    await getDb()
      .update(catalogEntities)
      .set({ popularity: 70, statsFollowers: 100, statsTracks: 1, statsTotalPlays: 100000 })
      .where(eq(catalogEntities.id, id));

    const res = makeRes();
    await getMadeForYou(makeReq(), res as unknown as Response, next);

    const body = res._body as {
      albums: unknown[];
      playlists: unknown[];
      tracks: Array<{ title: string }>;
      artists: Array<{ id: string; name: string }>;
    };
    expect(body.albums).toHaveLength(0);
    expect(body.tracks.length).toBeGreaterThan(0);
    expect(body.tracks[0].title).toBe('Popular');
    expect(body.artists.length).toBeGreaterThan(0);
    expect(body.artists[0].id).toBe(id);
  });

  it('does not include track/artist fallback when albums fill the section', async () => {
    // Seed enough albums to satisfy half the default limit (20 → half=10)
    for (let i = 0; i < 10; i++) {
      const albumId = await seedAlbum({ title: `Album ${i}`, source: 'cc', popularity: 50 });
      await seedTrack({ title: `Album Track ${i}`, albumId, playCount: i });
    }
    await seedTrack({ title: 'Should Not Appear', playCount: 100000 });

    const res = makeRes();
    await getMadeForYou(makeReq(), res as unknown as Response, next);

    const body = res._body as { albums: unknown[]; tracks: unknown[] };
    expect(body.albums.length).toBe(10);
    expect(body.tracks).toHaveLength(0);
  });
});
