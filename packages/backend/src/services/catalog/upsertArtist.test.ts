import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect, installCatalogImageMirrorMockForTests } from '../../test/mongo';
import { ArtistModel } from '../../models/CatalogEntity';
import { upsertArtist } from './upsertArtist';
import { setCatalogImageMirrorImplementationForTests } from './catalogImageAssets';
import type { ExternalArtist } from '@syra/shared-types';

beforeAll(connect);
afterEach(async () => {
  installCatalogImageMirrorMockForTests();
  await clear();
});
afterAll(disconnect);

const audiusArtist: ExternalArtist = {
  name: 'Deadmau5',
  externalId: 'audius-artist-123',
  images: [{ url: 'https://audius.co/img/deadmau5.jpg', width: 400, height: 400 }],
};

describe('upsertArtist', () => {
  it('(a) inserts a new external artist with the given source', async () => {
    const { artist, created } = await upsertArtist(audiusArtist, 'audius');

    expect(created).toBe(true);
    if (!artist) throw new Error('expected artist');
    expect(artist.name).toBe('Deadmau5');
    expect(artist.source).toBe('audius');
    expect(artist.externalIds?.audiusId).toBe('audius-artist-123');
    expect(artist.claimable).toBe(true);
    expect(await ArtistModel.countDocuments()).toBe(1);
  });

  it('(b) re-import with same audiusId updates the SAME doc — no duplicate', async () => {
    await upsertArtist(audiusArtist, 'audius');
    const { artist, created } = await upsertArtist(
      { ...audiusArtist, name: 'deadmau5 (updated)' },
      'audius',
    );

    expect(created).toBe(false);
    if (!artist) throw new Error('expected artist');
    expect(artist.name).toBe('deadmau5 (updated)');
    expect(await ArtistModel.countDocuments()).toBe(1);
  });

  it('(c) same name from different sources creates two distinct docs', async () => {
    await upsertArtist({
      name: 'Bonobo',
      externalId: 'aud-bonobo',
      images: [{ url: 'https://audius.co/img/bonobo.jpg' }],
    }, 'audius');
    await upsertArtist({
      name: 'Bonobo',
      externalId: 'cc-bonobo',
      images: [{ url: 'https://cc.example/img/bonobo.jpg' }],
    }, 'cc');

    expect(await ArtistModel.countDocuments()).toBe(2);
  });

  it('skips a new imported artist with no usable image', async () => {
    const { artist, created } = await upsertArtist(
      { name: 'No Image', externalId: 'aud-no-image' },
      'audius',
    );

    expect(created).toBe(false);
    expect(artist).toBeNull();
    expect(await ArtistModel.countDocuments()).toBe(0);
  });

  it('skips a new imported artist when image mirroring fails', async () => {
    setCatalogImageMirrorImplementationForTests(async () => undefined);

    const { artist, created } = await upsertArtist(audiusArtist, 'audius');

    expect(created).toBe(false);
    expect(artist).toBeNull();
    expect(await ArtistModel.countDocuments()).toBe(0);
  });

  it('(d) a SourceProvenance entry is appended on each import', async () => {
    await upsertArtist(audiusArtist, 'audius');
    const { artist } = await upsertArtist(audiusArtist, 'audius');

    if (!artist) throw new Error('expected artist');
    expect(artist.sources).toBeDefined();
    expect(artist.sources?.length).toBe(2);

    const prov = artist.sources?.[0];
    expect(prov?.provider).toBe('audius');
    expect(prov?.externalId).toBe('audius-artist-123');
    expect(typeof prov?.importedAt).toBe('string');
    // importedAt is a valid ISO string
    expect(new Date(prov?.importedAt ?? '').toISOString()).toBe(prov?.importedAt);
    expect(Array.isArray(prov?.fields)).toBe(true);
  });

  it('(e) an owned artist (ownerOxyUserId set) is never overwritten by an import', async () => {
    // Seed an artist that a real user owns
    const owned = await ArtistModel.create({
      name: 'Deadmau5',
      source: 'upload',
      bio: 'The real one.',
      image: 'objectid-abc',
      ownerOxyUserId: 'oxy-user-999',
      externalIds: { audiusId: 'audius-artist-123' },
      stats: { followers: 0, albums: 0, tracks: 0, totalPlays: 0, monthlyListeners: 0 },
    });

    const { artist, created } = await upsertArtist(audiusArtist, 'audius');

    expect(created).toBe(false);
    if (!artist) throw new Error('expected artist');
    expect(artist.id).toBe(owned.id);
    // Owned fields are untouched
    expect(artist.bio).toBe('The real one.');
    expect(artist.image).toBe('objectid-abc');
    expect(artist.ownerOxyUserId).toBe('oxy-user-999');
    // But provenance was still appended
    expect(artist.sources?.length).toBeGreaterThanOrEqual(1);
  });
});
