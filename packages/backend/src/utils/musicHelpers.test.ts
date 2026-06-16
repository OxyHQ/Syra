import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import { AlbumModel } from '../models/Album';
import {
  formatTrackWithCoverArt,
  formatAlbumWithCoverArt,
  formatArtistWithImage,
} from './musicHelpers';

// These tests exercise plain-object paths — no DB queries needed for
// the images[] fallback, but formatTrackWithCoverArt may query AlbumModel
// when albumId is set. Use in-memory mongo so the optional album fetch
// doesn't crash.
beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

// ── Track — images[] fallback ─────────────────────────────────────────────────

describe('formatTrackWithCoverArt — images[] fallback', () => {
  it('uses images[0].url as coverArt when no coverArt ObjectId', async () => {
    const track = {
      _id: new mongoose.Types.ObjectId(),
      title: 'Audius Track',
      artistName: 'Artist',
      images: [{ url: 'https://audius.co/art.jpg' }],
    };

    const result = await formatTrackWithCoverArt(track);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBe('https://audius.co/art.jpg');
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

// ── Album — images[] fallback ─────────────────────────────────────────────────

describe('formatAlbumWithCoverArt — images[] fallback', () => {
  it('uses images[0].url as coverArt when no coverArt ObjectId', () => {
    const album = {
      _id: new mongoose.Types.ObjectId(),
      title: 'Audius Album',
      artistName: 'Artist',
      images: [{ url: 'https://audius.co/album.jpg' }],
    };

    const result = formatAlbumWithCoverArt(album);

    expect(result).not.toBeNull();
    expect(result.coverArt).toBe('https://audius.co/album.jpg');
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

// ── Artist — images[] fallback ────────────────────────────────────────────────

describe('formatArtistWithImage — images[] fallback', () => {
  it('uses images[0].url as image when no image ObjectId', () => {
    const artist = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Audius Artist',
      images: [{ url: 'https://audius.co/artist.jpg' }],
    };

    const result = formatArtistWithImage(artist);

    expect(result).not.toBeNull();
    expect(result.image).toBe('https://audius.co/artist.jpg');
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

// ── Track → album images[] fallback (DB-backed) ───────────────────────────────

describe('formatTrackWithCoverArt — album images[] fallback', () => {
  it('uses album images[0].url when track has albumId but album has no ObjectId coverArt', async () => {
    // Insert an album that has only images[] (no coverArt ObjectId).
    // Using collection.insertOne to bypass the Mongoose schema validator
    // which marks coverArt as required — this mirrors real Audius-imported albums.
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
    expect(result.coverArt).toBe('https://x.com/album.jpg');
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

  it('falls back to track own images[] when album has neither coverArt nor images[]', async () => {
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
    expect(result.coverArt).toBe('https://track.com/art.jpg');
  });
});
