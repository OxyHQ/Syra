import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../test/mongo';
import { CatalogEntityModel, ArtistModel, PersonModel } from './CatalogEntity';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

describe('CatalogEntity discriminator', () => {
  it('artists and persons live in ONE collection but stay type-scoped', async () => {
    await ArtistModel.create({ name: 'The Band', source: 'cc' });
    await PersonModel.create({ name: 'Jane Host' });

    // Same physical collection.
    expect(ArtistModel.collection.name).toBe('catalogentities');
    expect(PersonModel.collection.name).toBe('catalogentities');
    expect(CatalogEntityModel.collection.name).toBe('catalogentities');

    // The discriminator auto-injects the `type` filter into find().
    const artists = await ArtistModel.find({}).lean();
    expect(artists).toHaveLength(1);
    expect(artists[0]?.name).toBe('The Band');
    expect(artists[0]?.type).toBe('artist');

    const persons = await PersonModel.find({}).lean();
    expect(persons).toHaveLength(1);
    expect(persons[0]?.name).toBe('Jane Host');
    expect(persons[0]?.type).toBe('person');

    // Base model sees BOTH.
    const all = await CatalogEntityModel.find({}).lean();
    expect(all).toHaveLength(2);
  });

  it('ArtistModel.find() never returns person docs (and vice-versa)', async () => {
    await PersonModel.create({ name: 'Only A Person' });

    // An un-filtered artist query must NOT leak the person.
    expect(await ArtistModel.find({}).lean()).toHaveLength(0);
    expect(await ArtistModel.countDocuments({})).toBe(0);
    expect(await PersonModel.find({}).lean()).toHaveLength(1);
  });

  it('persons strong-key dedup: one entity per linkedOxyUserId (sparse-unique)', async () => {
    // syncIndexes() awaits the sparse-unique index build (autoIndex alone races the insert).
    await CatalogEntityModel.syncIndexes();
    await PersonModel.create({ name: 'Oxy User', linkedOxyUserId: 'oxy-1' });
    await expect(
      PersonModel.create({ name: 'Oxy User Dup', linkedOxyUserId: 'oxy-1' }),
    ).rejects.toThrow();
  });
});
