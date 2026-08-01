import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { clear, connect, disconnect } from '../../test/mongo';
import { AlbumModel } from '../../models/Album';
import { classifyAlbumType, ensureContributedAlbum, resolveAlbum } from './resolveAlbum';

beforeAll(connect);
beforeEach(async () => {
  await AlbumModel.createIndexes();
});
afterEach(clear);
afterAll(disconnect);

const ARTIST_ID = new mongoose.Types.ObjectId().toString();
const COVER_ART = new mongoose.Types.ObjectId().toString();

async function seedAlbum(overrides: Record<string, unknown> = {}) {
  return AlbumModel.create({
    title: 'Harbour Lights',
    artistId: ARTIST_ID,
    artistName: 'Nadia Ortiz',
    releaseDate: '2023-04-18',
    coverArt: COVER_ART,
    source: 'upload',
    ...overrides,
  });
}

describe('resolveAlbum — tier order', () => {
  it('tier 1: a UPC links the release', async () => {
    const album = await seedAlbum({ upc: '8437011234567' });
    const resolution = await resolveAlbum({
      albumName: 'Something Else Entirely',
      upc: '8437011234567',
    });

    expect(resolution.confidence).toBe('high');
    expect(resolution.signal).toBe('upc');
    expect(resolution.linkedAlbumId).toBe(album._id.toString());
  });

  it('tier 2: a MusicBrainz release id links the release', async () => {
    const album = await seedAlbum({
      externalIds: { musicbrainzReleaseId: '4f2a1d3b-8ec6-4a35-9d21-7f0c5b6e2a90' },
    });
    const resolution = await resolveAlbum({
      albumName: 'Harbour Lights',
      musicbrainzReleaseId: '4f2a1d3b-8ec6-4a35-9d21-7f0c5b6e2a90',
    });

    expect(resolution.confidence).toBe('high');
    expect(resolution.signal).toBe('musicbrainz-release-id');
    expect(resolution.linkedAlbumId).toBe(album._id.toString());
  });

  it('tier 1 wins over tier 2', async () => {
    const byUpc = await seedAlbum({ upc: '8437011234567' });
    await seedAlbum({
      title: 'Different Album',
      externalIds: { musicbrainzReleaseId: '4f2a1d3b-8ec6-4a35-9d21-7f0c5b6e2a90' },
    });

    const resolution = await resolveAlbum({
      albumName: 'Harbour Lights',
      upc: '8437011234567',
      musicbrainzReleaseId: '4f2a1d3b-8ec6-4a35-9d21-7f0c5b6e2a90',
    });
    expect(resolution.linkedAlbumId).toBe(byUpc._id.toString());
    expect(resolution.signal).toBe('upc');
  });

  it('tier 3: artist + title + year is MEDIUM — it reports but does not link', async () => {
    const album = await seedAlbum();
    const resolution = await resolveAlbum({
      albumName: 'harbour  lights',
      albumArtistName: 'Nadia Ortíz',
      artistId: ARTIST_ID,
      year: 2023,
    });

    expect(resolution.confidence).toBe('medium');
    expect(resolution.signal).toBe('album-key');
    expect(resolution.matchedAlbumId).toBe(album._id.toString());
    expect(resolution.linkedAlbumId).toBeUndefined();
  });

  it('tier 3 does not match across a different year — reissues are different releases', async () => {
    await seedAlbum();
    const resolution = await resolveAlbum({
      albumName: 'Harbour Lights',
      albumArtistName: 'Nadia Ortiz',
      artistId: ARTIST_ID,
      year: 2011,
    });

    expect(resolution.confidence).toBe('none');
    expect(resolution.matchedAlbumId).toBeUndefined();
  });

  it('returns nothing usable when the file names no album', async () => {
    const resolution = await resolveAlbum({ albumArtistName: 'Nadia Ortiz' });
    expect(resolution.confidence).toBe('none');
    expect(resolution.title).toBeUndefined();
    expect(resolution.albumKey).toBeUndefined();
  });

  it('carries the grouping key so a multi-file upload makes ONE album', async () => {
    const first = await resolveAlbum({
      albumName: 'Harbour Lights',
      albumArtistName: 'Nadia Ortiz',
      year: 2023,
    });
    const second = await resolveAlbum({
      albumName: 'harbour lights',
      albumArtistName: 'NADIA ORTÍZ',
      year: 2023,
    });

    expect(first.albumKey).toBe(second.albumKey ?? '');
    expect(first.albumKey).toContain('nadia ortiz');
  });
});

describe('classifyAlbumType', () => {
  it('a compilation flag wins outright', () => {
    expect(classifyAlbumType({ compilation: true, totalTracks: 1 })).toBe('compilation');
  });

  it('a placeholder album artist means compilation', () => {
    // The one place a denylisted name is USEFUL: it may not become an entity,
    // but as a statement about the release it is exactly right.
    expect(classifyAlbumType({ albumArtistName: 'Various Artists', totalTracks: 20 })).toBe(
      'compilation',
    );
    expect(classifyAlbumType({ albumArtistName: 'VA', totalTracks: 20 })).toBe('compilation');
  });

  it('1–2 tracks is a single, 3–6 an EP', () => {
    expect(classifyAlbumType({ totalTracks: 1 })).toBe('single');
    expect(classifyAlbumType({ totalTracks: 2 })).toBe('single');
    expect(classifyAlbumType({ totalTracks: 3 })).toBe('ep');
    expect(classifyAlbumType({ totalTracks: 6 })).toBe('ep');
  });

  it('more than 6 tracks is an album unless the whole release runs under 30 minutes', () => {
    expect(classifyAlbumType({ totalTracks: 12 })).toBe('album');
    expect(classifyAlbumType({ totalTracks: 12, totalDurationSec: 25 * 60 })).toBe('ep');
    expect(classifyAlbumType({ totalTracks: 12, totalDurationSec: 45 * 60 })).toBe('album');
  });

  it('defaults to album when the tags say nothing', () => {
    // NOT `single`: guessing that from one uploaded file would mislabel every
    // track somebody uploads one at a time, which is most of them.
    expect(classifyAlbumType({})).toBe('album');
    expect(classifyAlbumType({ totalDurationSec: 200 })).toBe('album');
  });
});

describe('ensureContributedAlbum — no cover art means no album', () => {
  it('creates the album when it has art and a date', async () => {
    const album = await ensureContributedAlbum({
      title: 'Harbour Lights',
      artistId: ARTIST_ID,
      artistName: 'Nadia Ortiz',
      coverArt: COVER_ART,
      releaseDate: '2023-04-18',
      type: 'album',
      totalTracks: 12,
      genres: ['Indie Pop'],
      upc: '8437011234567',
    });

    if (!album) throw new Error('expected an album');
    expect(album.title).toBe('Harbour Lights');
    expect(album.coverArt).toBe(COVER_ART);
    expect(album.upc).toBe('8437011234567');
    expect(album.totalTracks).toBe(12);
  });

  it('DECLINES rather than inventing a placeholder cover', async () => {
    // A generated grey square becomes the album's real cover the moment it is
    // written and there is no way afterwards to tell it from a release that
    // genuinely looks like that. Loose tracks under the artist is the correct
    // outcome; a fabricated image is not.
    const album = await ensureContributedAlbum({
      title: 'Harbour Lights',
      artistId: ARTIST_ID,
      artistName: 'Nadia Ortiz',
      releaseDate: '2023-04-18',
    });

    expect(album).toBeNull();
    expect(await AlbumModel.countDocuments()).toBe(0);
  });

  it('declines without a release date too', async () => {
    const album = await ensureContributedAlbum({
      title: 'Harbour Lights',
      artistId: ARTIST_ID,
      artistName: 'Nadia Ortiz',
      coverArt: COVER_ART,
    });

    expect(album).toBeNull();
    expect(await AlbumModel.countDocuments()).toBe(0);
  });

  it('two concurrent contributions of the same UPC produce ONE album', async () => {
    const [a, b] = await Promise.all([
      ensureContributedAlbum({
        title: 'Harbour Lights',
        artistId: ARTIST_ID,
        artistName: 'Nadia Ortiz',
        coverArt: COVER_ART,
        releaseDate: '2023-04-18',
        upc: '8437011234567',
      }),
      ensureContributedAlbum({
        title: 'Harbour Lights',
        artistId: ARTIST_ID,
        artistName: 'Nadia Ortiz',
        coverArt: COVER_ART,
        releaseDate: '2023-04-18',
        upc: '8437011234567',
      }),
    ]);

    expect(await AlbumModel.countDocuments()).toBe(1);
    expect(a?._id.toString()).toBe(b?._id.toString() ?? '');
  });
});
