import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../test/mongo';
import { TrackModel } from '../models/Track';
import { AlbumModel } from '../models/Album';
import { ArtistModel } from '../models/CatalogEntity';
import { PlaylistModel } from '../models/Playlist';
import { PlaylistTrackModel } from '../models/PlaylistTrack';
import { UserMusicPreferencesModel } from '../models/UserMusicPreferences';
import { PlaylistVisibility } from '@syra/shared-types';
import { getGenres, getHomeBrowse, getMadeForYou, getPopularAlbums, getPopularTracks } from './browse.controller';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { Request, Response, NextFunction } from 'express';

beforeAll(connect);
afterEach(async () => {
  delete process.env.AUDIUS_CATALOG_ENABLED;
  await clear();
});
afterAll(disconnect);

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

async function seedTrack(overrides: Record<string, unknown> = {}): Promise<string> {
  const track = await TrackModel.create({
    title: 'A Track',
    artistId: '507f1f77bcf86cd799439011',
    artistName: 'An Artist',
    duration: 180,
    source: 'cc',
    status: 'ready',
    isExplicit: false,
    isAvailable: true,
    ...overrides,
  });

  return track._id.toString();
}

async function seedPlaylistWithTrack(
  playlistName: string,
  trackOverrides: Record<string, unknown> = {},
  playlistOverrides: Record<string, unknown> = {},
): Promise<void> {
  const playlist = await PlaylistModel.create({
    name: playlistName,
    ownerOxyUserId: 'system:test',
    ownerUsername: 'Test',
    visibility: PlaylistVisibility.PUBLIC,
    trackCount: 1,
    totalDuration: 180,
    followers: 0,
    source: trackOverrides.source,
    ...playlistOverrides,
  });
  const trackId = await seedTrack({
    title: `${playlistName} Track`,
    ...trackOverrides,
  });

  await PlaylistTrackModel.create({
    playlistId: playlist._id,
    trackId,
    addedAt: '2026-01-01T00:00:00.000Z',
    order: 0,
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

  it('only surfaces genres backed by playable tracks', async () => {
    await seedTrack({ genre: 'Electronic' });
    await ArtistModel.create({
      name: 'Artist Genre',
      source: 'cc',
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
      source: 'cc',
    });

    const res = makeRes();
    await getGenres(makeReq(), res as unknown as Response, next);

    const body = res._body as { genres: Array<{ name: string }> };
    const names = body.genres.map((g) => g.name).sort();
    expect(names).toEqual(['Electronic']);
  });

  it('does not use track images[] external URLs as genre cover art', async () => {
    await seedTrack({
      genre: 'Electronic',
      images: [{ url: 'https://cdn/track-art.jpg', width: 1000, height: 1000, source: 'audius' }],
    });

    const res = makeRes();
    await getGenres(makeReq(), res as unknown as Response, next);

    const body = res._body as { genres: Array<{ name: string; coverArt: string | null }> };
    const electronic = body.genres.find((g) => g.name === 'Electronic');
    expect(electronic?.coverArt).toBeNull();
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

  it('excludes Audius tracks by default', async () => {
    await seedTrack({ title: 'Audius High', source: 'audius', playCount: 100000, popularity: 99 });
    await seedTrack({ title: 'Playable Low', source: 'cc', playCount: 10, popularity: 1 });

    const res = makeRes();
    await getPopularTracks(makeReq(), res as unknown as Response, next);

    const body = res._body as { tracks: Array<{ title: string }> };
    expect(body.tracks.map((t) => t.title)).toEqual(['Playable Low']);
  });

  it('includes Audius tracks rehosted through Syra when the Audius catalog is enabled', async () => {
    process.env.AUDIUS_CATALOG_ENABLED = 'true';
    await seedTrack({
      title: 'Audius Rehosted',
      source: 'audius',
      status: 'ready',
      playCount: 100000,
      popularity: 99,
      hlsMasterKey: 'hls/audius/rehosted/master.m3u8',
      hls: [{ manifestKey: 'hls/audius/rehosted/160/index.m3u8', bitrateKbps: 160, encrypted: true }],
    });
    await seedTrack({
      title: 'Audius Direct Only',
      source: 'audius',
      status: 'ready',
      streamUrl: 'https://discoveryprovider.audius.co/v1/tracks/direct/stream?app_name=Syra',
      playCount: 90000,
      popularity: 90,
    });

    const res = makeRes();
    await getPopularTracks(makeReq(), res as unknown as Response, next);

    const body = res._body as { tracks: Array<{ title: string }> };
    expect(body.tracks.map((t) => t.title)).toEqual(['Audius Rehosted']);
  });

  it('includes direct-only Audius tracks when the signed-in user enabled direct streaming', async () => {
    process.env.AUDIUS_CATALOG_ENABLED = 'true';
    await seedTrack({
      title: 'Audius Direct Only',
      source: 'audius',
      status: 'ready',
      streamUrl: 'https://discoveryprovider.audius.co/v1/tracks/direct/stream?app_name=Syra',
      playCount: 100000,
      popularity: 99,
    });
    await UserMusicPreferencesModel.create({
      oxyUserId: 'oxy-user-direct',
      directAudiusStreaming: true,
    });

    const res = makeRes();
    await getPopularTracks(makeReq({}, 'oxy-user-direct'), res as unknown as Response, next);

    const body = res._body as { tracks: Array<{ title: string }> };
    expect(body.tracks.map((t) => t.title)).toEqual(['Audius Direct Only']);
    expect(res._headers['Cache-Control']).toBe('private, max-age=30, stale-while-revalidate=120');
    expect(res._headers.Vary).toBe('Authorization');
  });
});

// ── getPopularAlbums ─────────────────────────────────────────────────────────

describe('getPopularAlbums', () => {
  it('excludes albums with no playable tracks for the current playback policy', async () => {
    process.env.AUDIUS_CATALOG_ENABLED = 'true';
    const playableAlbum = await AlbumModel.create({
      title: 'Playable Album',
      artistId: '507f1f77bcf86cd799439011',
      artistName: 'An Artist',
      releaseDate: '2026-01-01T00:00:00Z',
      coverArt: '507f1f77bcf86cd799439012',
      source: 'audius',
      popularity: 80,
    });
    const directOnlyAlbum = await AlbumModel.create({
      title: 'Direct Only Album',
      artistId: '507f1f77bcf86cd799439011',
      artistName: 'An Artist',
      releaseDate: '2026-01-01T00:00:00Z',
      coverArt: '507f1f77bcf86cd799439013',
      source: 'audius',
      popularity: 99,
    });
    await seedTrack({
      title: 'Syra Hosted Audius',
      source: 'audius',
      albumId: playableAlbum._id.toString(),
      status: 'ready',
      popularity: 80,
      hlsMasterKey: 'hls/audius/rehosted/master.m3u8',
      hls: [{ manifestKey: 'hls/audius/rehosted/160/index.m3u8', bitrateKbps: 160, encrypted: true }],
    });
    await seedTrack({
      title: 'Direct Audius',
      source: 'audius',
      albumId: directOnlyAlbum._id.toString(),
      status: 'ready',
      popularity: 99,
      streamUrl: 'https://discoveryprovider.audius.co/v1/tracks/direct/stream?app_name=Syra',
    });

    const res = makeRes();
    await getPopularAlbums(makeReq(), res as unknown as Response, next);

    const body = res._body as { albums: Array<{ title: string }> };
    expect(body.albums.map((album) => album.title)).toEqual(['Playable Album']);
  });

  it('includes direct-only Audius albums when the signed-in user enabled direct streaming', async () => {
    process.env.AUDIUS_CATALOG_ENABLED = 'true';
    const album = await AlbumModel.create({
      title: 'Direct Only Album',
      artistId: '507f1f77bcf86cd799439011',
      artistName: 'An Artist',
      releaseDate: '2026-01-01T00:00:00Z',
      coverArt: '507f1f77bcf86cd799439013',
      source: 'audius',
      popularity: 99,
    });
    await seedTrack({
      title: 'Direct Audius',
      source: 'audius',
      albumId: album._id.toString(),
      status: 'ready',
      popularity: 99,
      streamUrl: 'https://discoveryprovider.audius.co/v1/tracks/direct/stream?app_name=Syra',
    });
    await UserMusicPreferencesModel.create({
      oxyUserId: 'oxy-user-direct',
      directAudiusStreaming: true,
    });

    const res = makeRes();
    await getPopularAlbums(makeReq({}, 'oxy-user-direct'), res as unknown as Response, next);

    const body = res._body as { albums: Array<{ title: string }> };
    expect(body.albums.map((listedAlbum) => listedAlbum.title)).toEqual(['Direct Only Album']);
    expect(res._headers['Cache-Control']).toBe('private, max-age=30, stale-while-revalidate=120');
    expect(res._headers.Vary).toBe('Authorization');
  });
});

// ── getHomeBrowse ───────────────────────────────────────────────────────────

describe('getHomeBrowse', () => {
  it('does not surface playlists whose tracks are not playable for the current playback policy', async () => {
    process.env.AUDIUS_CATALOG_ENABLED = 'true';
    await seedPlaylistWithTrack(
      'Direct Only Playlist',
      {
        source: 'audius',
        status: 'ready',
        streamUrl: 'https://discoveryprovider.audius.co/v1/tracks/direct/stream?app_name=Syra',
      },
      { followers: 100 },
    );
    await seedPlaylistWithTrack(
      'Syra Hosted Playlist',
      {
        source: 'audius',
        status: 'ready',
        hlsMasterKey: 'hls/audius/rehosted/master.m3u8',
        hls: [{ manifestKey: 'hls/audius/rehosted/160/index.m3u8', bitrateKbps: 160, encrypted: true }],
      },
      { followers: 1 },
    );

    const res = makeRes();
    await getHomeBrowse(makeReq({ sectionLimit: '4', tracksLimit: '4' }), res as unknown as Response, next);

    const body = res._body as { madeForYou: { playlists: Array<{ name: string }> } };
    expect(body.madeForYou.playlists.map((playlist) => playlist.name)).toEqual(['Syra Hosted Playlist']);
  });

  it('surfaces direct-only playlists when the signed-in user enabled direct streaming', async () => {
    process.env.AUDIUS_CATALOG_ENABLED = 'true';
    await seedPlaylistWithTrack(
      'Direct Only Playlist',
      {
        source: 'audius',
        status: 'ready',
        streamUrl: 'https://discoveryprovider.audius.co/v1/tracks/direct/stream?app_name=Syra',
      },
      { followers: 100 },
    );
    await UserMusicPreferencesModel.create({
      oxyUserId: 'oxy-user-direct',
      directAudiusStreaming: true,
    });

    const res = makeRes();
    await getHomeBrowse(makeReq({ sectionLimit: '4', tracksLimit: '4' }, 'oxy-user-direct'), res as unknown as Response, next);

    const body = res._body as { madeForYou: { playlists: Array<{ name: string }> } };
    expect(body.madeForYou.playlists.map((playlist) => playlist.name)).toEqual(['Direct Only Playlist']);
    expect(res._headers['Cache-Control']).toBe('private, max-age=60, stale-while-revalidate=300');
    expect(res._headers.Vary).toBe('Authorization');
  });
});

// ── getMadeForYou ─────────────────────────────────────────────────────────────

describe('getMadeForYou', () => {
  it('excludes playlists with no playable tracks from public discovery', async () => {
    process.env.AUDIUS_CATALOG_ENABLED = 'true';
    await seedPlaylistWithTrack('Direct Only Playlist', {
      source: 'audius',
      status: 'ready',
      streamUrl: 'https://discoveryprovider.audius.co/v1/tracks/direct/stream?app_name=Syra',
    });

    const res = makeRes();
    await getMadeForYou(makeReq(), res as unknown as Response, next);

    const body = res._body as { playlists: Array<{ name: string }> };
    expect(body.playlists).toHaveLength(0);
  });

  it('falls back to popular tracks + artists when albums/playlists are sparse', async () => {
    const artistId = '507f1f77bcf86cd799439011';
    await seedTrack({ title: 'Popular', artistId, playCount: 100000, popularity: 80 });
    await ArtistModel.create({
      _id: artistId,
      name: 'Popular Artist',
      source: 'cc',
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
      const album = await AlbumModel.create({
        title: `Album ${i}`,
        artistId: '507f1f77bcf86cd799439011',
        artistName: 'An Artist',
        releaseDate: '2021-01-01T00:00:00Z',
        coverArt: `https://cdn/cover-${i}.jpg`,
        source: 'cc',
        popularity: 50,
      });
      await seedTrack({
        title: `Album Track ${i}`,
        albumId: album._id.toString(),
        playCount: i,
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
