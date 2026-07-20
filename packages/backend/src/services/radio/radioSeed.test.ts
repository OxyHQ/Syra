import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import mongoose from 'mongoose';
import { PlaylistVisibility } from '@syra/shared-types';
import { connect, clear, disconnect } from '../../test/mongo';
import { loadRadioTaste, resolveRadioSeed } from './radioSeed';
import {
  addPlaylistTracks,
  makeAlbum,
  makeArtist,
  makeLibrary,
  makePlaylist,
  makeTasteProfile,
  makeTrack,
} from './radioFixtures';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const MISSING_ID = new mongoose.Types.ObjectId().toString();

describe('resolveRadioSeed — track', () => {
  it('resolves the track as its own CF seed with its artist, genre and mood', async () => {
    const artistId = await makeArtist({ name: 'Nova' });
    const track = await makeTrack({
      title: 'Signal',
      artistId,
      artistName: 'Nova',
      genre: 'house',
      mood: 'euphoric',
      tags: ['late-night'],
    });

    const seed = await resolveRadioSeed({ seedType: 'track', seedId: track._id.toString() }, undefined);

    expect(seed).not.toBeNull();
    expect(seed?.seedTrackIds).toEqual([track._id.toString()]);
    expect(seed?.seedArtistIds).toEqual([artistId]);
    expect(seed?.genres).toEqual(['house']);
    expect(seed?.moods).toEqual(['euphoric']);
    expect(seed?.tags).toEqual(['late-night']);
    expect(seed?.title).toBe('Signal Radio');
    expect(seed?.personalized).toBe(false);
  });

  it('returns null for a missing track, a malformed id and a copyright-removed track', async () => {
    const struck = await makeTrack({ copyrightRemoved: true });

    expect(await resolveRadioSeed({ seedType: 'track', seedId: MISSING_ID }, undefined)).toBeNull();
    expect(await resolveRadioSeed({ seedType: 'track', seedId: 'not-an-id' }, undefined)).toBeNull();
    expect(
      await resolveRadioSeed({ seedType: 'track', seedId: struck._id.toString() }, undefined)
    ).toBeNull();
  });
});

describe('resolveRadioSeed — artist', () => {
  it("seeds from the artist's top playable tracks and their genres", async () => {
    const artistId = await makeArtist({ name: 'Nova', genres: ['house'] });
    const popular = await makeTrack({ artistId, popularity: 90, title: 'Peak' });
    const deepCut = await makeTrack({ artistId, popularity: 10, title: 'Deep' });
    await makeTrack({ artistId, popularity: 100, copyrightRemoved: true, title: 'Struck' });

    const seed = await resolveRadioSeed({ seedType: 'artist', seedId: artistId }, undefined);

    expect(seed?.seedTrackIds).toEqual([popular._id.toString(), deepCut._id.toString()]);
    expect(seed?.seedArtistIds).toEqual([artistId]);
    expect(seed?.genres).toEqual(['house']);
    expect(seed?.title).toBe('Nova Radio');
  });

  it('falls back to track genres when the artist row carries none', async () => {
    const artistId = await makeArtist({ name: 'Nova', genres: [] });
    await makeTrack({ artistId, genre: 'ambient' });

    const seed = await resolveRadioSeed({ seedType: 'artist', seedId: artistId }, undefined);

    expect(seed?.genres).toEqual(['ambient']);
  });

  it('returns null for a missing artist', async () => {
    expect(await resolveRadioSeed({ seedType: 'artist', seedId: MISSING_ID }, undefined)).toBeNull();
  });
});

describe('resolveRadioSeed — album', () => {
  it('seeds from the album and its playable tracks', async () => {
    const artistId = await makeArtist({ name: 'Nova' });
    const albumId = await makeAlbum({ title: 'Orbit', artistId, artistName: 'Nova', genre: ['house'] });
    const first = await makeTrack({ albumId, artistId, trackNumber: 1, mood: 'calm' });
    await makeTrack({ albumId, artistId, trackNumber: 2, isAvailable: false });

    const seed = await resolveRadioSeed({ seedType: 'album', seedId: albumId }, undefined);

    expect(seed?.seedTrackIds).toEqual([first._id.toString()]);
    expect(seed?.seedArtistIds).toEqual([artistId]);
    expect(seed?.genres).toEqual(['house']);
    expect(seed?.moods).toEqual(['calm']);
    expect(seed?.title).toBe('Orbit Radio');
  });

  it('returns null for an unpublished album', async () => {
    const albumId = await makeAlbum({ isAvailable: false });

    expect(await resolveRadioSeed({ seedType: 'album', seedId: albumId }, undefined)).toBeNull();
  });
});

describe('resolveRadioSeed — playlist', () => {
  it('seeds from the playlist tracks in playlist order, dropping unplayable ones', async () => {
    const playlistId = await makePlaylist({ name: 'Night Drive' });
    const first = await makeTrack({ genre: 'house', title: 'A' });
    const struck = await makeTrack({ copyrightRemoved: true, title: 'B' });
    const third = await makeTrack({ genre: 'techno', title: 'C' });
    await addPlaylistTracks(playlistId, [
      first._id.toString(),
      struck._id.toString(),
      third._id.toString(),
    ]);

    const seed = await resolveRadioSeed({ seedType: 'playlist', seedId: playlistId }, undefined);

    expect(seed?.seedTrackIds).toEqual([first._id.toString(), third._id.toString()]);
    expect(seed?.genres).toEqual(['house', 'techno']);
    expect(seed?.title).toBe('Night Drive Radio');
  });

  it('refuses a private playlist for a guest and for a stranger, but not for its owner', async () => {
    const playlistId = await makePlaylist({
      ownerOxyUserId: 'owner-1',
      visibility: PlaylistVisibility.PRIVATE,
    });

    expect(await resolveRadioSeed({ seedType: 'playlist', seedId: playlistId }, undefined)).toBeNull();
    expect(
      await resolveRadioSeed({ seedType: 'playlist', seedId: playlistId }, 'stranger')
    ).toBeNull();
    expect(
      await resolveRadioSeed({ seedType: 'playlist', seedId: playlistId }, 'owner-1')
    ).not.toBeNull();
  });
});

describe('resolveRadioSeed — genre and mood', () => {
  it('lowercases the seed id and titles the station', async () => {
    await makeTrack({ genre: 'deep house', mood: 'chill' });

    const genreSeed = await resolveRadioSeed({ seedType: 'genre', seedId: 'Deep House' }, undefined);
    expect(genreSeed?.genres).toEqual(['deep house']);
    expect(genreSeed?.moods).toEqual([]);
    expect(genreSeed?.seedTrackIds).toEqual([]);
    expect(genreSeed?.title).toBe('Deep House Radio');

    const moodSeed = await resolveRadioSeed({ seedType: 'mood', seedId: 'CHILL' }, undefined);
    expect(moodSeed?.moods).toEqual(['chill']);
    expect(moodSeed?.genres).toEqual([]);
    expect(moodSeed?.title).toBe('Chill Radio');
  });

  it('returns null when nothing playable carries the genre or mood', async () => {
    await makeTrack({ genre: 'house', mood: 'chill', copyrightRemoved: true });

    expect(await resolveRadioSeed({ seedType: 'genre', seedId: 'house' }, undefined)).toBeNull();
    expect(await resolveRadioSeed({ seedType: 'mood', seedId: 'chill' }, undefined)).toBeNull();
    expect(await resolveRadioSeed({ seedType: 'genre', seedId: '  ' }, undefined)).toBeNull();
  });
});

describe('resolveRadioSeed — user', () => {
  it('seeds from the taste profile and the most recent likes', async () => {
    const artistId = await makeArtist({ name: 'Nova' });
    const liked = await makeTrack({ artistId });
    await makeTasteProfile('user-1', [{ key: 'house', weight: 9 }], [{ key: artistId, weight: 5 }]);
    await makeLibrary('user-1', [liked._id.toString()]);

    const seed = await resolveRadioSeed({ seedType: 'user', seedId: '' }, 'user-1');

    expect(seed?.seedArtistIds).toEqual([artistId]);
    expect(seed?.genres).toEqual(['house']);
    expect(seed?.seedTrackIds).toEqual([liked._id.toString()]);
    expect(seed?.title).toBe('Your Daily Mix');
    expect(seed?.personalized).toBe(true);
  });

  it('cold start and guests resolve with empty seeds and personalized: false', async () => {
    const guest = await resolveRadioSeed({ seedType: 'user', seedId: '' }, undefined);
    expect(guest?.personalized).toBe(false);
    expect(guest?.seedArtistIds).toEqual([]);
    expect(guest?.genres).toEqual([]);
    expect(guest?.title).toBe('Your Daily Mix');

    const coldStart = await resolveRadioSeed({ seedType: 'user', seedId: '' }, 'user-with-no-profile');
    expect(coldStart?.personalized).toBe(false);
  });

  it('treats a zero-weight profile as cold start', async () => {
    await makeTasteProfile('user-2', [{ key: 'house', weight: 0 }], []);

    const seed = await resolveRadioSeed({ seedType: 'user', seedId: '' }, 'user-2');

    expect(seed?.personalized).toBe(false);
    expect(seed?.genres).toEqual([]);
  });
});

describe('loadRadioTaste', () => {
  it('normalises affinities against the listener\'s own strongest weight', async () => {
    await makeTasteProfile(
      'user-1',
      [
        { key: 'house', weight: 10 },
        { key: 'techno', weight: 5 },
      ],
      [{ key: 'artist-a', weight: 4 }]
    );

    const taste = await loadRadioTaste('user-1');

    expect(taste.genreAffinity).toEqual({ house: 1, techno: 0.5 });
    expect(taste.artistAffinity).toEqual({ 'artist-a': 1 });
  });

  it('scores a guest and an unknown user flat', async () => {
    expect(await loadRadioTaste(undefined)).toEqual({ artistAffinity: {}, genreAffinity: {} });
    expect(await loadRadioTaste('nobody')).toEqual({ artistAffinity: {}, genreAffinity: {} });
  });
});
