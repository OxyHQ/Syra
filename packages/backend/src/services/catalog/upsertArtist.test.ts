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

const externalArtist: ExternalArtist = {
  name: 'Deadmau5',
  externalId: 'audius-artist-123',
  images: [{ url: 'https://cdn.example/img/deadmau5.jpg', width: 400, height: 400 }],
};

describe('upsertArtist', () => {
  it('(a) inserts a new external artist with the given source', async () => {
    const { artist, created } = await upsertArtist(externalArtist, 'cc');

    expect(created).toBe(true);
    if (!artist) throw new Error('expected artist');
    expect(artist.name).toBe('Deadmau5');
    expect(artist.source).toBe('cc');
    expect(artist.claimable).toBe(true);
    expect(await ArtistModel.countDocuments()).toBe(1);
  });


  it('(c) same name from different sources creates two distinct docs', async () => {
    await upsertArtist({
      name: 'Bonobo',
      externalId: 'aud-bonobo',
      images: [{ url: 'https://cdn.example/img/bonobo.jpg' }],
    }, 'cc');
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
      'cc',
    );

    expect(created).toBe(false);
    expect(artist).toBeNull();
    expect(await ArtistModel.countDocuments()).toBe(0);
  });

  it('skips a new imported artist when image mirroring fails', async () => {
    setCatalogImageMirrorImplementationForTests(async () => undefined);

    const { artist, created } = await upsertArtist(externalArtist, 'cc');

    expect(created).toBe(false);
    expect(artist).toBeNull();
    expect(await ArtistModel.countDocuments()).toBe(0);
  });

  it('(d) a SourceProvenance entry is appended on each import', async () => {
    await upsertArtist(externalArtist, 'cc');
    const { artist } = await upsertArtist(externalArtist, 'cc');

    if (!artist) throw new Error('expected artist');
    expect(artist.sources).toBeDefined();
    expect(artist.sources?.length).toBe(2);

    const prov = artist.sources?.[0];
    expect(prov?.provider).toBe('cc');
    expect(prov?.externalId).toBe('audius-artist-123');
    const importedAt = prov?.importedAt;
    expect(typeof importedAt).toBe('string');
    if (importedAt === undefined) throw new Error('expected importedAt');
    // importedAt is a valid ISO string
    expect(new Date(importedAt).toISOString()).toBe(importedAt);
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
      sources: [{ provider: 'cc', externalId: 'audius-artist-123', importedAt: new Date().toISOString(), fields: [] }],
      stats: { followers: 0, albums: 0, tracks: 0, totalPlays: 0, monthlyListeners: 0 },
    });

    const { artist, created } = await upsertArtist(externalArtist, 'cc');

    expect(created).toBe(false);
    if (!artist) throw new Error('expected artist');
    expect(artist._id.toString()).toBe(owned._id.toString());
    // Owned fields are untouched
    expect(artist.bio).toBe('The real one.');
    expect(artist.image).toBe('objectid-abc');
    expect(artist.ownerOxyUserId).toBe('oxy-user-999');
    // But provenance was still appended
    expect(artist.sources?.length).toBeGreaterThanOrEqual(1);
  });
});
