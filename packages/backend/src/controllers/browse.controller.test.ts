import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../test/mongo';
import { TrackModel } from '../models/Track';
import { AlbumModel } from '../models/Album';
import { ArtistModel } from '../models/Artist';
import { getGenres, getMadeForYou, getPopularTracks } from './browse.controller';
import type { Request, Response, NextFunction } from 'express';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

// ── Fake req/res helpers ──────────────────────────────────────────────────────

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

function makeReq(query: Record<string, string> = {}): Request {
  return { query } as unknown as Request;
}

const next: NextFunction = (err?: unknown) => {
  if (err) throw err;
};

// ── Seed helpers ───────────────────────────────────────────────────────────────

async function seedTrack(overrides: Record<string, unknown> = {}): Promise<void> {
  await TrackModel.create({
    title: 'A Track',
    artistId: '507f1f77bcf86cd799439011',
    artistName: 'An Artist',
    duration: 180,
    source: 'audius',
    status: 'ready',
    isExplicit: false,
    isAvailable: true,
    ...overrides,
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

  it('unions track, album, and artist genres without duplicates', async () => {
    await seedTrack({ genre: 'Electronic' });
    await ArtistModel.create({
      name: 'Artist Genre',
      source: 'audius',
      genres: ['Electronic', 'Jazz'],
      stats: { followers: 0, albums: 0, tracks: 0, totalPlays: 0 },
    });
    await AlbumModel.create({
      title: 'Album Genre',
      artistId: '507f1f77bcf86cd799439011',
      artistName: 'An Artist',
      releaseDate: '2021-01-01T00:00:00Z',
      coverArt: 'https://cdn/cover.jpg',
      genre: ['Hip-Hop/Rap'],
      source: 'audius',
    });

    const res = makeRes();
    await getGenres(makeReq(), res as unknown as Response, next);

    const body = res._body as { genres: Array<{ name: string }> };
    const names = body.genres.map((g) => g.name).sort();
    expect(names).toEqual(['Electronic', 'Hip-Hop/Rap', 'Jazz']);
  });

  it('uses a track image as genre cover art fallback when no album/artist art', async () => {
    await seedTrack({
      genre: 'Electronic',
      images: [{ url: 'https://cdn/track-art.jpg', width: 1000, height: 1000, source: 'audius' }],
    });

    const res = makeRes();
    await getGenres(makeReq(), res as unknown as Response, next);

    const body = res._body as { genres: Array<{ name: string; coverArt: string | null }> };
    const electronic = body.genres.find((g) => g.name === 'Electronic');
    expect(electronic?.coverArt).toBe('https://cdn/track-art.jpg');
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

// ── getMadeForYou ─────────────────────────────────────────────────────────────

describe('getMadeForYou', () => {
  it('falls back to popular tracks + artists when albums/playlists are sparse', async () => {
    await seedTrack({ title: 'Popular', playCount: 100000, popularity: 80 });
    await ArtistModel.create({
      name: 'Popular Artist',
      source: 'audius',
      popularity: 70,
      stats: { followers: 100, albums: 0, tracks: 1, totalPlays: 100000 },
    });

    const res = makeRes();
    await getMadeForYou(makeReq(), res as unknown as Response, next);

    const body = res._body as {
      albums: unknown[];
      playlists: unknown[];
      tracks: Array<{ title: string }>;
      artists: Array<{ name: string }>;
    };
    expect(body.albums).toHaveLength(0);
    expect(body.tracks.length).toBeGreaterThan(0);
    expect(body.tracks[0].title).toBe('Popular');
    expect(body.artists.length).toBeGreaterThan(0);
    expect(body.artists[0].name).toBe('Popular Artist');
  });

  it('does not include track/artist fallback when albums fill the section', async () => {
    // Seed enough albums to satisfy half the default limit (20 → half=10)
    for (let i = 0; i < 10; i++) {
      await AlbumModel.create({
        title: `Album ${i}`,
        artistId: '507f1f77bcf86cd799439011',
        artistName: 'An Artist',
        releaseDate: '2021-01-01T00:00:00Z',
        coverArt: `https://cdn/cover-${i}.jpg`,
        source: 'audius',
        popularity: 50,
      });
    }
    await seedTrack({ title: 'Should Not Appear', playCount: 100000 });

    const res = makeRes();
    await getMadeForYou(makeReq(), res as unknown as Response, next);

    const body = res._body as { albums: unknown[]; tracks: unknown[] };
    expect(body.albums.length).toBe(10);
    expect(body.tracks).toHaveLength(0);
  });
});
