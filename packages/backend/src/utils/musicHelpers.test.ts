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
      title: 'Audius Track',
      artistName: 'Artist',
      images: [{ url: 'https://audius.co/art.jpg' }],
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
      images: [{ url: 'https://audius.co/art.jpg' }],
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

// ── previewAvailable — Audius rehosted to Syra HLS (no audioSource) ────────────

describe('formatTrackWithCoverArt — previewAvailable for Audius-HLS', () => {
  const prev = process.env.AUDIUS_CATALOG_ENABLED;
  beforeAll(() => { process.env.AUDIUS_CATALOG_ENABLED = 'true'; });
  afterAll(() => {
    if (prev === undefined) delete process.env.AUDIUS_CATALOG_ENABLED;
    else process.env.AUDIUS_CATALOG_ENABLED = prev;
  });

  it('is true for an Audius track rehosted to ready Syra HLS (no audioSource)', async () => {
    const result = await formatTrackWithCoverArt({
      _id: new mongoose.Types.ObjectId(),
      title: 'Audius HLS Track',
      artistName: 'Artist',
      source: 'audius',
      status: 'ready',
      isAvailable: true,
      hlsMasterKey: 'hls/a/t/master.m3u8',
      hls: [{ manifestKey: 'hls/a/t/96/stream.m3u8', bitrateKbps: 96, encrypted: true }],
    });

    expect(result).not.toBeNull();
    expect(result.previewAvailable).toBe(true);
  });

  it('is false for an Audius track with only a direct provider stream (no Syra HLS)', async () => {
    const result = await formatTrackWithCoverArt({
      _id: new mongoose.Types.ObjectId(),
      title: 'Audius Direct Track',
      artistName: 'Artist',
      source: 'audius',
      status: 'ready',
      isAvailable: true,
      streamUrl: 'https://audius.example/stream',
    });

    expect(result).not.toBeNull();
    expect(result.previewAvailable).toBe(false);
  });

  it('is false for an Audius track whose HLS is not yet ready (processing)', async () => {
    const result = await formatTrackWithCoverArt({
      _id: new mongoose.Types.ObjectId(),
      title: 'Audius Processing Track',
      artistName: 'Artist',
      source: 'audius',
      status: 'processing',
      isAvailable: true,
      hls: [{ manifestKey: 'hls/a/t/96/stream.m3u8', bitrateKbps: 96, encrypted: true }],
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
      title: 'Audius Album',
      artistName: 'Artist',
      images: [{ url: 'https://audius.co/album.jpg' }],
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
      images: [{ url: 'https://audius.co/album.jpg' }],
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
      name: 'Audius Artist',
      images: [{ url: 'https://audius.co/artist.jpg' }],
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
      images: [{ url: 'https://audius.co/artist.jpg' }],
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
      name: 'Audius Playlist',
      images: [{ url: 'https://audius.co/playlist.jpg' }],
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
      images: [{ url: 'https://audius.co/playlist.jpg' }],
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
      title: 'Audius Album',
      artistId: 'artist-1',
      artistName: 'Audius Artist',
      provider: 'audius',
      externalId: 'aud-alb-1',
      importedAt: new Date().toISOString(),
      releaseDate: '2024-01-01',
      images: [{ url: 'https://x.com/album.jpg', width: 480, height: 480, source: 'audius' }],
    });

    const track = {
      _id: new mongoose.Types.ObjectId(),
      title: 'Audius Track',
      artistName: 'Audius Artist',
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
