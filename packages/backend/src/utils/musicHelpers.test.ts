import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, disconnect } from '../test/mongo';
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
