import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect, installCatalogImageMirrorMockForTests } from '../../test/mongo';
import { TrackModel } from '../../models/Track';
import { ArtistModel } from '../../models/CatalogEntity';
import { upsertTrack } from './upsertTrack';
import { setCatalogImageMirrorImplementationForTests } from './catalogImageAssets';
import type { ExternalTrack } from '@syra/shared-types';

beforeAll(connect);
afterEach(async () => {
  installCatalogImageMirrorMockForTests();
  await clear();
});
afterAll(disconnect);

const baseTrack: ExternalTrack = {
  provider: 'cc',
  externalId: 'aud-track-001',
  title: 'Strobe',
  artists: [{
    name: 'deadmau5',
    externalId: 'aud-artist-001',
    images: [{ url: 'https://cdn.example/img/deadmau5.jpg', width: 600, height: 600 }],
  }],
  durationSec: 600,
  isrc: 'USUG11400419',
  images: [{ url: 'https://cdn.example/img/strobe.jpg', width: 600, height: 600 }],
};

describe('upsertTrack', () => {
  it('(a) inserts a new track: count=1, artistId populated, source/status correct', async () => {
    const { track, created } = await upsertTrack(baseTrack, 'cc');

    expect(created).toBe(true);
    if (!track) throw new Error('expected track');
    expect(await TrackModel.countDocuments()).toBe(1);
    expect(track.title).toBe('Strobe');
    expect(track.source).toBe('cc');
    // A CC import must be downloaded + ingested before it is playable.
    expect(track.status).toBe('processing');
    // artistId must be a real ObjectId string (24 hex chars), not empty
    expect(track.artistId).toMatch(/^[0-9a-f]{24}$/);
    expect(track.artistName).toBe('deadmau5');
    expect(track.externalIds?.isrc).toBe('USUG11400419');
    expect(track.duration).toBe(600);
  });

  it('(b) re-import with same ISRC updates the SAME doc and appends provenance', async () => {
    await upsertTrack(baseTrack, 'cc');
    const { track, created } = await upsertTrack(
      { ...baseTrack, title: 'Strobe (Remaster)' },
      'cc',
    );

    expect(created).toBe(false);
    if (!track) throw new Error('expected track');
    expect(await TrackModel.countDocuments()).toBe(1);
    expect(track.title).toBe('Strobe (Remaster)');
    expect(track.sources?.length).toBe(2);
    // Both provenance entries record the correct provider and externalId
    expect(track.sources?.[0].provider).toBe('cc');
    expect(track.sources?.[0].externalId).toBe('aud-track-001');
    expect(track.sources?.[1].provider).toBe('cc');
    const importedAt = track.sources?.[1].importedAt;
    expect(typeof importedAt).toBe('string');
    if (importedAt === undefined) throw new Error('expected importedAt');
    expect(new Date(importedAt).toISOString()).toBe(importedAt);
  });

  describe('(c) no-ISRC fuzzy dedup: title + artistName + duration ±2s', () => {
    const noIsrc: ExternalTrack = {
      provider: 'cc',
      externalId: 'cc-track-999',
      title: 'Café Soleil',
      artists: [{
        name: 'Bonobo',
        externalId: 'cc-artist-999',
        images: [{ url: 'https://cc.example/img/bonobo.jpg' }],
      }],
      durationSec: 180,
      images: [{ url: 'https://cc.example/img/cafe-soleil.jpg' }],
    };

    it('same title/artist, duration within ±2s → same doc', async () => {
      await upsertTrack(noIsrc, 'cc');
      const { created } = await upsertTrack(
        { ...noIsrc, externalId: 'cc-track-999b', durationSec: 181 },
        'cc',
      );

      expect(created).toBe(false);
      expect(await TrackModel.countDocuments()).toBe(1);
    });

    it('same title/artist, duration outside ±2s → different doc', async () => {
      await upsertTrack(noIsrc, 'cc');
      const { created } = await upsertTrack(
        { ...noIsrc, externalId: 'cc-track-999c', durationSec: 185 },
        'cc',
      );

      expect(created).toBe(true);
      expect(await TrackModel.countDocuments()).toBe(2);
    });

    it('diacritics/case in title normalise to same fuzzy key', async () => {
      await upsertTrack(noIsrc, 'cc');
      // 'Cafe Soleil' should normalise the same as 'Café Soleil'
      const { created } = await upsertTrack(
        { ...noIsrc, title: 'CAFE SOLEIL', externalId: 'cc-track-999d', durationSec: 181 },
        'cc',
      );

      expect(created).toBe(false);
      expect(await TrackModel.countDocuments()).toBe(1);
    });
  });

  describe('(e) provider metadata persistence', () => {
    const richTrack: ExternalTrack = {
      provider: 'cc',
      externalId: 'aud-rich-001',
      title: 'Rich Track',
      artists: [{
        name: 'Genre Artist',
        externalId: 'aud-genre-artist',
        images: [{ url: 'https://cdn.example/img/genre-artist.jpg' }],
      }],
      durationSec: 200,
      images: [{ url: 'https://cdn.example/img/rich-track.jpg' }],
      genre: 'Electronic',
      mood: 'Energizing',
      tags: ['lofi', 'chill'],
      releaseDate: '2021-05-01T00:00:00Z',
      popularity: { playCount: 12345, favoriteCount: 678, repostCount: 90 },
    };

    it('persists genre/mood/tags/releaseDate/popularity signals onto the track', async () => {
      const { track } = await upsertTrack(richTrack, 'cc');

      if (!track) throw new Error('expected track');
      expect(track.genre).toBe('Electronic');
      expect(track.mood).toBe('Energizing');
      expect(track.tags).toEqual(['lofi', 'chill']);
      expect(track.releaseDate?.toISOString()).toBe('2021-05-01T00:00:00.000Z');
      expect(track.playCount).toBe(12345);
      expect(track.favoriteCount).toBe(678);
      expect(track.repostCount).toBe(90);
      // popularity (0-100) is derived from playCount and must be > 0 for a played track
      expect(track.popularity).toBeGreaterThan(0);
    });

    it('rolls the track genre up into the artist genres (union, no duplicates)', async () => {
      await upsertTrack(richTrack, 'cc');
      // Second track, same artist, different genre → artist accrues both
      await upsertTrack(
        { ...richTrack, externalId: 'aud-rich-002', title: 'Rich Track 2', genre: 'House' },
        'cc',
      );
      // Third track, same artist, repeat genre → no duplicate
      await upsertTrack(
        { ...richTrack, externalId: 'aud-rich-003', title: 'Rich Track 3', genre: 'Electronic' },
        'cc',
      );

      const artist = await ArtistModel.findOne({ sources: { $elemMatch: { provider: 'cc', externalId: 'aud-genre-artist' } } });
      expect(artist).not.toBeNull();
      expect(artist?.genres?.slice().sort()).toEqual(['Electronic', 'House']);
    });

    it('does not clobber existing track popularity signals with missing ones on re-import', async () => {
      await upsertTrack(richTrack, 'cc');
      const { track } = await upsertTrack(
        { ...richTrack, popularity: undefined, genre: undefined },
        'cc',
      );

      // Existing values survive a re-import that omits them
      if (!track) throw new Error('expected track');
      expect(track.playCount).toBe(12345);
      expect(track.genre).toBe('Electronic');
    });
  });

  it('(d) merge never clobbers non-empty field with empty; sources[].fields recorded', async () => {
    await upsertTrack(baseTrack, 'cc');

    // Re-import with no ISRC.
    const { track } = await upsertTrack(
      { ...baseTrack, isrc: undefined },
      'cc',
    );

    // Provider image URLs are never persisted; the internal cover art survives.
    if (!track) throw new Error('expected track');
    expect(track.images?.length ?? 0).toBe(0);
    expect(track.coverArt).toMatch(/^[a-f\d]{24}$/i);
    expect(track.coverArtSizes?.large?.url).toBe(`/api/images/${track.coverArt}`);
    expect(track.externalIds?.isrc).toBe('USUG11400419');

    // sources[].fields must list the fields the FIRST import contributed
    const firstProv = track.sources?.[0];
    expect(firstProv?.fields).toContain('title');
    expect(firstProv?.fields).toContain('isrc');
    expect(firstProv?.fields).toContain('images');
  });

  it('skips a new imported track when the track artwork is missing', async () => {
    const { track, created } = await upsertTrack(
      { ...baseTrack, externalId: 'aud-no-cover', isrc: undefined, images: undefined },
      'cc',
    );

    expect(created).toBe(false);
    expect(track).toBeNull();
    expect(await TrackModel.countDocuments()).toBe(0);
  });

  it('skips a new imported track and artist when track image mirroring fails', async () => {
    setCatalogImageMirrorImplementationForTests(async (images, context) => {
      if (context.entityType === 'track') return undefined;
      const imageId = '64f000000000000000000001';
      return {
        imageId,
        imageSizes: {
          large: {
            id: imageId,
            url: `/api/images/${imageId}`,
            width: 640,
            height: 640,
          },
        },
        primaryColor: '#336699',
        secondaryColor: '#224466',
        sourceUrlHash: `test-url-${images?.[0]?.url ?? context.externalId}`,
        sourceContentHash: `test-content-${context.externalId}`,
      };
    });

    const { track, created } = await upsertTrack(
      { ...baseTrack, externalId: 'aud-mirror-fail', isrc: undefined },
      'cc',
    );

    expect(created).toBe(false);
    expect(track).toBeNull();
    expect(await TrackModel.countDocuments()).toBe(0);
    expect(await ArtistModel.countDocuments()).toBe(0);
  });

  it('skips a new imported track when the primary artist image is missing', async () => {
    const { track, created } = await upsertTrack(
      {
        ...baseTrack,
        externalId: 'aud-no-artist-image',
        isrc: undefined,
        artists: [{ name: 'No Image Artist', externalId: 'aud-no-image-artist' }],
      },
      'cc',
    );

    expect(created).toBe(false);
    expect(track).toBeNull();
    expect(await TrackModel.countDocuments()).toBe(0);
    expect(await ArtistModel.countDocuments()).toBe(0);
  });
});
