import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import { AlbumModel } from '../models/Album';
import {
  formatTrackWithCoverArt,
  formatAlbumWithCoverArt,
  formatArtistWithImage,
  formatPlaylistWithCoverArt,
} from './musicHelpers';

// These tests exercise plain-object paths. formatTrackWithCoverArt may query AlbumModel
// when albumId is set. Use in-memory mongo so the optional album fetch
// doesn't crash.
beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

// ── Track — internal image formatting ─────────────────────────────────────────

describe('formatTrackWithCoverArt — internal image formatting', () => {
  it('does not expose images[0].url as coverArt when no internal coverArt exists', async () => {
    const track = {
      _id: new mongoose.Types.ObjectId(),
      title: 'External Track',
      artistName: 'Artist',
      images: [{ url: 'https://cdn.example/art.jpg' }],
    };

    const result = await formatTrackWithCoverArt(track);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBeUndefined();
    expect(result.images).toBeUndefined();
  });

  it('prefers ObjectId coverArt over images[] (does NOT override real art)', async () => {
    const objectId = new mongoose.Types.ObjectId();
    const track = {
      _id: new mongoose.Types.ObjectId(),
      title: 'Upload Track',
      artistName: 'Artist',
      coverArt: objectId.toString(),
      images: [{ url: 'https://cdn.example/art.jpg' }],
    };

    const result = await formatTrackWithCoverArt(track);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBe(`/api/images/${objectId.toString()}`);
  });

  it('returns undefined coverArt when neither ObjectId nor images[] present', async () => {
    const track = {
      _id: new mongoose.Types.ObjectId(),
      title: 'No Art Track',
      artistName: 'Artist',
    };

    const result = await formatTrackWithCoverArt(track);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBeUndefined();
  });

  it('ignores images[] entry with empty url', async () => {
    const track = {
      _id: new mongoose.Types.ObjectId(),
      title: 'Empty URL Track',
      artistName: 'Artist',
      images: [{ url: '' }],
    };

    const result = await formatTrackWithCoverArt(track);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBeUndefined();
  });
});

// ── Track — previewAvailable flag ─────────────────────────────────────────────

describe('formatTrackWithCoverArt — previewAvailable', () => {
  it('is true for an available upload track with a retained audio source', async () => {
    const result = await formatTrackWithCoverArt({
      _id: new mongoose.Types.ObjectId(),
      title: 'Upload Track',
      artistName: 'Artist',
      source: 'upload',
      status: 'ready',
      isAvailable: true,
      audioSource: { url: '/api/audio/x', format: 'mp3' },
    });

    expect(result).not.toBeNull();
    expect(result.previewAvailable).toBe(true);
  });

  it('is false when there is no regenerable audio source', async () => {
    const result = await formatTrackWithCoverArt({
      _id: new mongoose.Types.ObjectId(),
      title: 'Sourceless Track',
      artistName: 'Artist',
      source: 'upload',
      status: 'ready',
      isAvailable: true,
    });

    expect(result).not.toBeNull();
    expect(result.previewAvailable).toBe(false);
  });

  it('is false when the track is unavailable', async () => {
    const result = await formatTrackWithCoverArt({
      _id: new mongoose.Types.ObjectId(),
      title: 'Unavailable Track',
      artistName: 'Artist',
      source: 'upload',
      status: 'ready',
      isAvailable: false,
      audioSource: { url: '/api/audio/x', format: 'mp3' },
    });

    expect(result).not.toBeNull();
    expect(result.previewAvailable).toBe(false);
  });
});

// ── Album — internal image formatting ─────────────────────────────────────────

describe('formatAlbumWithCoverArt — internal image formatting', () => {
  it('does not expose images[0].url as coverArt when no internal coverArt exists', () => {
    const album = {
      _id: new mongoose.Types.ObjectId(),
      title: 'External Album',
      artistName: 'Artist',
      images: [{ url: 'https://cdn.example/album.jpg' }],
    };

    const result = formatAlbumWithCoverArt(album);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBeUndefined();
    expect(result.images).toBeUndefined();
  });

  it('prefers ObjectId coverArt over images[]', () => {
    const objectId = new mongoose.Types.ObjectId();
    const album = {
      _id: new mongoose.Types.ObjectId(),
      title: 'Upload Album',
      artistName: 'Artist',
      coverArt: objectId.toString(),
      images: [{ url: 'https://cdn.example/album.jpg' }],
    };

    const result = formatAlbumWithCoverArt(album);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBe(`/api/images/${objectId.toString()}`);
  });

  it('returns undefined coverArt when neither ObjectId nor images[] present', () => {
    const album = {
      _id: new mongoose.Types.ObjectId(),
      title: 'No Art Album',
      artistName: 'Artist',
    };

    const result = formatAlbumWithCoverArt(album);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBeUndefined();
  });
});

// ── Artist — internal image formatting ────────────────────────────────────────

describe('formatArtistWithImage — internal image formatting', () => {
  it('does not expose images[0].url as image when no internal image exists', () => {
    const artist = {
      _id: new mongoose.Types.ObjectId(),
      name: 'External Artist',
      images: [{ url: 'https://cdn.example/artist.jpg' }],
    };

    const result = formatArtistWithImage(artist);

    expect(result).not.toBeNull();
    expect(result.image).toBeUndefined();
    expect(result.images).toBeUndefined();
  });

  it('prefers ObjectId image over images[]', () => {
    const objectId = new mongoose.Types.ObjectId();
    const artist = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Upload Artist',
      image: objectId.toString(),
      images: [{ url: 'https://cdn.example/artist.jpg' }],
    };

    const result = formatArtistWithImage(artist);

    expect(result).not.toBeNull();
    expect(result.image).toBe(`/api/images/${objectId.toString()}`);
  });

  it('returns undefined image when neither ObjectId nor images[] present', () => {
    const artist = {
      _id: new mongoose.Types.ObjectId(),
      name: 'No Art Artist',
    };

    const result = formatArtistWithImage(artist);

    expect(result).not.toBeNull();
    expect(result.image).toBeUndefined();
  });

  it('ignores images[] entry with missing url field', () => {
    const artist = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Bad Images Artist',
      images: [{}],
    };

    const result = formatArtistWithImage(artist);

    expect(result).not.toBeNull();
    expect(result.image).toBeUndefined();
  });
});

// ── Playlist — internal image formatting ──────────────────────────────────────

describe('formatPlaylistWithCoverArt — internal image formatting', () => {
  it('does not expose images[0].url as coverArt when no internal coverArt exists', () => {
    const playlist = {
      _id: new mongoose.Types.ObjectId(),
      name: 'External Playlist',
      images: [{ url: 'https://cdn.example/playlist.jpg' }],
    };

    const result = formatPlaylistWithCoverArt(playlist);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBeUndefined();
    expect(result.images).toBeUndefined();
  });

  it('prefers ObjectId coverArt over images[]', () => {
    const objectId = new mongoose.Types.ObjectId();
    const playlist = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Upload Playlist',
      coverArt: objectId.toString(),
      images: [{ url: 'https://cdn.example/playlist.jpg' }],
    };

    const result = formatPlaylistWithCoverArt(playlist);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBe(`/api/images/${objectId.toString()}`);
  });
});

// ── Track → album internal cover art (DB-backed) ──────────────────────────────

describe('formatTrackWithCoverArt — album internal cover art', () => {
  it('does not expose album images[0].url when track has albumId but album has no internal coverArt', async () => {
    const albumId = new mongoose.Types.ObjectId();
    await AlbumModel.collection.insertOne({
      _id: albumId,
      title: 'External Album',
      artistId: 'artist-1',
      artistName: 'External Artist',
      provider: 'cc',
      externalId: 'aud-alb-1',
      importedAt: new Date().toISOString(),
      releaseDate: '2024-01-01',
      images: [{ url: 'https://x.com/album.jpg', width: 480, height: 480, source: 'cc' }],
    });

    const track = {
      _id: new mongoose.Types.ObjectId(),
      title: 'External Track',
      artistName: 'External Artist',
      albumId: albumId.toString(),
      // no coverArt, no own images[]
    };

    const result = await formatTrackWithCoverArt(track);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBeUndefined();
  });

  it('album ObjectId coverArt takes priority over album images[]', async () => {
    const albumId = new mongoose.Types.ObjectId();
    const coverArtId = new mongoose.Types.ObjectId();
    await AlbumModel.collection.insertOne({
      _id: albumId,
      title: 'Upload Album',
      artistId: 'artist-1',
      artistName: 'Upload Artist',
      provider: 'upload',
      externalId: 'upl-alb-1',
      importedAt: new Date().toISOString(),
      releaseDate: '2024-01-01',
      coverArt: coverArtId.toString(),
      images: [{ url: 'https://x.com/album-external.jpg' }],
    });

    const track = {
      _id: new mongoose.Types.ObjectId(),
      title: 'Upload Track',
      artistName: 'Upload Artist',
      albumId: albumId.toString(),
    };

    const result = await formatTrackWithCoverArt(track);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBe(`/api/images/${coverArtId.toString()}`);
  });

  it('does not fall back to track own images[] when album has no internal coverArt', async () => {
    const albumId = new mongoose.Types.ObjectId();
    await AlbumModel.collection.insertOne({
      _id: albumId,
      title: 'Bare Album',
      artistId: 'artist-1',
      artistName: 'Bare Artist',
      provider: 'upload',
      externalId: 'bare-alb-1',
      importedAt: new Date().toISOString(),
      releaseDate: '2024-01-01',
    });

    const track = {
      _id: new mongoose.Types.ObjectId(),
      title: 'Track with own images',
      artistName: 'Bare Artist',
      albumId: albumId.toString(),
      images: [{ url: 'https://track.com/art.jpg' }],
    };

    const result = await formatTrackWithCoverArt(track);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBeUndefined();
    expect(result.images).toBeUndefined();
  });
});
