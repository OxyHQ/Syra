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
  trackExternalIds: ['aud-trk-base'],
};

/** Helper: import a track and return its DB _id + audius externalId. */
async function seedTrack(externalId: string, durationSec: number): Promise<string> {
  const external: ExternalTrack = {
    provider: 'audius',
    externalId,
    title: `Track ${externalId}`,
    artists: [{
      name: 'Album Artist',
      externalId: 'aud-album-artist',
      images: [{ url: 'https://cdn.audius.co/artist/1000x1000.jpg' }],
    }],
    durationSec,
    images: [{ url: `https://cdn.audius.co/${externalId}/1000x1000.jpg` }],
  };
  const { track } = await upsertTrack(external, 'audius');
  if (!track) throw new Error('expected track');
  return track._id.toString();
}

describe('upsertAlbum', () => {
  it('(a) inserts a new album with normalised metadata', async () => {
    await seedTrack('aud-trk-base', 120);
    const { album, created } = await upsertAlbum(baseAlbum, ARTIST, 'audius');

    expect(created).toBe(true);
    if (!album) throw new Error('expected album');
    expect(await AlbumModel.countDocuments()).toBe(1);
    expect(album.title).toBe('Night Drive');
    expect(album.artistName).toBe('Album Artist');
    expect(album.releaseDate).toBe('2021-06-26T14:24:05Z');
    expect(album.genre).toEqual(['Electronic']);
    expect(album.coverArt).toMatch(/^[a-f\d]{24}$/i);
    expect(album.coverArtSizes?.large?.url).toBe(`/api/images/${album.coverArt}`);
    expect(album.source).toBe('audius');
    expect(album.externalIds?.audiusId).toBe('aud-album-001');
    expect(album.playCount).toBe(5000);
    expect(album.favoriteCount).toBe(12);
    expect(album.popularity).toBeGreaterThan(0);
    expect(album.sources?.[0].provider).toBe('audius');
    expect(album.sources?.[0].externalId).toBe('aud-album-001');
  });

  it('(b) re-import with same externalId updates the SAME doc and appends provenance', async () => {
    await seedTrack('aud-trk-base', 120);
    await upsertAlbum(baseAlbum, ARTIST, 'audius');
    const { album, created } = await upsertAlbum(
      { ...baseAlbum, name: 'Night Drive (Deluxe)' },
      ARTIST,
      'audius',
    );

    expect(created).toBe(false);
    if (!album) throw new Error('expected album');
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

    if (!album) throw new Error('expected album');
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
    if (!album) throw new Error('expected album');
    expect(album.totalTracks).toBe(1);
    expect(album.totalDuration).toBe(100);
  });

  it('(e) skips albums with no usable cover art (coverArt is required)', async () => {
    await seedTrack('aud-trk-base', 120);
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

  it('(f) skips Audius albums with no resolved tracks', async () => {
    const { album, created } = await upsertAlbum(
      { ...baseAlbum, trackExternalIds: ['aud-missing'] },
      ARTIST,
      'audius',
    );

    expect(created).toBe(false);
    expect(album).toBeNull();
    expect(await AlbumModel.countDocuments()).toBe(0);
  });
});
