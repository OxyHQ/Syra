import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { TrackModel } from '../../models/Track';
import { ArtistModel } from '../../models/Artist';
import { upsertTrack } from './upsertTrack';
import type { ExternalTrack } from '@syra/shared-types';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const baseTrack: ExternalTrack = {
  provider: 'audius',
  externalId: 'aud-track-001',
  title: 'Strobe',
  artists: [{ name: 'deadmau5', externalId: 'aud-artist-001' }],
  durationSec: 600,
  isrc: 'USUG11400419',
  images: [{ url: 'https://audius.co/img/strobe.jpg', width: 600, height: 600 }],
  streamUrl: 'https://audius.co/stream/aud-track-001',
};

describe('upsertTrack', () => {
  it('(a) inserts a new track: count=1, artistId populated, source/status correct', async () => {
    const { track, created } = await upsertTrack(baseTrack, 'audius');

    expect(created).toBe(true);
    expect(await TrackModel.countDocuments()).toBe(1);
    expect(track.title).toBe('Strobe');
    expect(track.source).toBe('audius');
    expect(track.status).toBe('ready');
    // artistId must be a real ObjectId string (24 hex chars), not empty
    expect(track.artistId).toMatch(/^[0-9a-f]{24}$/);
    expect(track.artistName).toBe('deadmau5');
    expect(track.externalIds?.isrc).toBe('USUG11400419');
    expect(track.externalIds?.audiusId).toBe('aud-track-001');
    expect(track.duration).toBe(600);
  });

  it('(b) re-import with same ISRC updates the SAME doc and appends provenance', async () => {
    await upsertTrack(baseTrack, 'audius');
    const { track, created } = await upsertTrack(
      { ...baseTrack, title: 'Strobe (Remaster)' },
      'audius',
    );

    expect(created).toBe(false);
    expect(await TrackModel.countDocuments()).toBe(1);
    expect(track.title).toBe('Strobe (Remaster)');
    expect(track.sources?.length).toBe(2);
    // Both provenance entries record the correct provider and externalId
    expect(track.sources?.[0].provider).toBe('audius');
    expect(track.sources?.[0].externalId).toBe('aud-track-001');
    expect(track.sources?.[1].provider).toBe('audius');
    expect(typeof track.sources?.[1].importedAt).toBe('string');
    expect(new Date(track.sources?.[1].importedAt ?? '').toISOString()).toBe(
      track.sources?.[1].importedAt,
    );
  });

  describe('(c) no-ISRC fuzzy dedup: title + artistName + duration ±2s', () => {
    const noIsrc: ExternalTrack = {
      provider: 'cc',
      externalId: 'cc-track-999',
      title: 'Café Soleil',
      artists: [{ name: 'Bonobo', externalId: 'cc-artist-999' }],
      durationSec: 180,
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
      provider: 'audius',
      externalId: 'aud-rich-001',
      title: 'Rich Track',
      artists: [{ name: 'Genre Artist', externalId: 'aud-genre-artist' }],
      durationSec: 200,
      genre: 'Electronic',
      mood: 'Energizing',
      tags: ['lofi', 'chill'],
      releaseDate: '2021-05-01T00:00:00Z',
      popularity: { playCount: 12345, favoriteCount: 678, repostCount: 90 },
    };

    it('persists genre/mood/tags/releaseDate/popularity signals onto the track', async () => {
      const { track } = await upsertTrack(richTrack, 'audius');

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
      await upsertTrack(richTrack, 'audius');
      // Second track, same artist, different genre → artist accrues both
      await upsertTrack(
        { ...richTrack, externalId: 'aud-rich-002', title: 'Rich Track 2', genre: 'House' },
        'audius',
      );
      // Third track, same artist, repeat genre → no duplicate
      await upsertTrack(
        { ...richTrack, externalId: 'aud-rich-003', title: 'Rich Track 3', genre: 'Electronic' },
        'audius',
      );

      const artist = await ArtistModel.findOne({ 'externalIds.audiusId': 'aud-genre-artist' });
      expect(artist).not.toBeNull();
      expect(artist?.genres?.slice().sort()).toEqual(['Electronic', 'House']);
    });

    it('does not clobber existing track popularity signals with missing ones on re-import', async () => {
      await upsertTrack(richTrack, 'audius');
      const { track } = await upsertTrack(
        { ...richTrack, popularity: undefined, genre: undefined },
        'audius',
      );

      // Existing values survive a re-import that omits them
      expect(track.playCount).toBe(12345);
      expect(track.genre).toBe('Electronic');
    });
  });

  it('(d) merge never clobbers non-empty field with empty; sources[].fields recorded', async () => {
    await upsertTrack(baseTrack, 'audius');

    // Re-import with no images / no streamUrl
    const { track } = await upsertTrack(
      { ...baseTrack, images: undefined, streamUrl: undefined },
      'audius',
    );

    // Non-empty image array from first import must survive
    expect(track.images?.length).toBeGreaterThan(0);
    expect(track.streamUrl).toBe('https://audius.co/stream/aud-track-001');

    // sources[].fields must list the fields the FIRST import contributed
    const firstProv = track.sources?.[0];
    expect(firstProv?.fields).toContain('title');
    expect(firstProv?.fields).toContain('streamUrl');
    expect(firstProv?.fields).toContain('images');
  });
});
