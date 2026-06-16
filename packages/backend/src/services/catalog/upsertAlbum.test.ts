import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { AlbumModel } from '../../models/Album';
import { TrackModel } from '../../models/Track';
import { upsertAlbum } from './upsertAlbum';
import { upsertTrack } from './upsertTrack';
import mongoose from 'mongoose';
import type { ExternalAlbum, ExternalTrack } from '@syra/shared-types';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const ARTIST = { artistId: new mongoose.Types.ObjectId().toString(), artistName: 'Album Artist' };

const baseAlbum: ExternalAlbum = {
  name: 'Night Drive',
  externalId: 'aud-album-001',
  releaseDate: '2021-06-26T14:24:05Z',
  genre: 'Electronic',
  images: [{ url: 'https://cdn.audius.co/alb/1000x1000.jpg', width: 1000, height: 1000 }],
  popularity: { playCount: 5000, favoriteCount: 12, repostCount: 3 },
  trackExternalIds: [],
};

/** Helper: import a track and return its DB _id + audius externalId. */
async function seedTrack(externalId: string, durationSec: number): Promise<string> {
  const external: ExternalTrack = {
    provider: 'audius',
    externalId,
    title: `Track ${externalId}`,
    artists: [{ name: 'Album Artist', externalId: 'aud-album-artist' }],
    durationSec,
  };
  const { track } = await upsertTrack(external, 'audius');
  return track._id.toString();
}

describe('upsertAlbum', () => {
  it('(a) inserts a new album with normalised metadata', async () => {
    const { album, created } = await upsertAlbum(baseAlbum, ARTIST, 'audius');

    expect(created).toBe(true);
    expect(await AlbumModel.countDocuments()).toBe(1);
    expect(album.title).toBe('Night Drive');
    expect(album.artistName).toBe('Album Artist');
    expect(album.releaseDate).toBe('2021-06-26T14:24:05Z');
    expect(album.genre).toEqual(['Electronic']);
    expect(album.coverArt).toBe('https://cdn.audius.co/alb/1000x1000.jpg');
    expect(album.source).toBe('audius');
    expect(album.externalIds?.audiusId).toBe('aud-album-001');
    expect(album.playCount).toBe(5000);
    expect(album.favoriteCount).toBe(12);
    expect(album.popularity).toBeGreaterThan(0);
    expect(album.sources?.[0].provider).toBe('audius');
    expect(album.sources?.[0].externalId).toBe('aud-album-001');
  });

  it('(b) re-import with same externalId updates the SAME doc and appends provenance', async () => {
    await upsertAlbum(baseAlbum, ARTIST, 'audius');
    const { album, created } = await upsertAlbum(
      { ...baseAlbum, name: 'Night Drive (Deluxe)' },
      ARTIST,
      'audius',
    );

    expect(created).toBe(false);
    expect(await AlbumModel.countDocuments()).toBe(1);
    expect(album.title).toBe('Night Drive (Deluxe)');
    expect(album.sources?.length).toBe(2);
  });

  it('(c) links member tracks by externalId: sets albumId and rolls up totals', async () => {
    const id1 = await seedTrack('aud-trk-1', 100);
    const id2 = await seedTrack('aud-trk-2', 150);

    const { album } = await upsertAlbum(
      { ...baseAlbum, trackExternalIds: ['aud-trk-1', 'aud-trk-2'] },
      ARTIST,
      'audius',
    );

    const albumId = album._id.toString();
    const t1 = await TrackModel.findById(id1);
    const t2 = await TrackModel.findById(id2);

    expect(t1?.albumId).toBe(albumId);
    expect(t2?.albumId).toBe(albumId);
    expect(album.totalTracks).toBe(2);
    expect(album.totalDuration).toBe(250);
  });

  it('(d) ignores track externalIds that are not yet in the catalog', async () => {
    await seedTrack('aud-trk-1', 100);

    const { album } = await upsertAlbum(
      { ...baseAlbum, trackExternalIds: ['aud-trk-1', 'aud-missing'] },
      ARTIST,
      'audius',
    );

    // Only the one known track is linked; totals reflect only it.
    expect(album.totalTracks).toBe(1);
    expect(album.totalDuration).toBe(100);
  });

  it('(e) skips albums with no usable cover art (coverArt is required)', async () => {
    const { album, created } = await upsertAlbum(
      { ...baseAlbum, images: undefined },
      ARTIST,
      'audius',
    );

    // No cover art → not persisted (Album.coverArt is required); reported as not created.
    expect(created).toBe(false);
    expect(album).toBeNull();
    expect(await AlbumModel.countDocuments()).toBe(0);
  });
});
