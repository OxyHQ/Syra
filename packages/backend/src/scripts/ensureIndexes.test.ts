import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import { ensureIndexes, planIndexes, loadAllModels } from './ensureIndexes';
import { ArtistModel, CatalogEntityModel, PersonModel } from '../models/CatalogEntity';
import { TrackModel } from '../models/Track';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

/** Index names on a collection, minus the implicit `_id_`. */
async function builtIndexNames(collectionName: string): Promise<string[]> {
  const indexes = await mongoose.connection.collection(collectionName).indexes();
  return indexes.map((index) => index.name ?? '').filter((name) => name !== '_id_').sort();
}

/**
 * FULL index definitions — key AND options — not just names.
 *
 * Names alone cannot see the difference this comparison exists to catch: an
 * index built with and without a `partialFilterExpression` has the SAME name, so
 * a name-only check passes while production silently gets a collection-wide
 * unique index where dev has a discriminator-scoped one. (An earlier version of
 * this test compared names; mutation-testing the decoration away did not fail a
 * single assertion, which is what exposed it.) `v` is dropped because it is the
 * server's index format version, not something either side chose.
 */
async function builtIndexDefinitions(collectionName: string): Promise<string[]> {
  const indexes = await mongoose.connection.collection(collectionName).indexes();
  return indexes
    .filter((index) => index.name !== '_id_')
    .map(({ v, ...definition }) => JSON.stringify(definition, Object.keys(definition).sort()))
    .sort();
}

async function dropAllIndexes(collectionName: string): Promise<void> {
  try {
    await mongoose.connection.collection(collectionName).dropIndexes();
  } catch {
    // Nothing to drop.
  }
}

describe('ensureIndexes — discovery', () => {
  it('finds every model without being told which ones exist', () => {
    loadAllModels();
    const planned = planIndexes();
    const models = new Set(planned.map((index) => index.modelName));

    // The point of reading the directory: a schema added later is covered with
    // no edit here. If this ever drops to a handful, discovery silently broke.
    expect(planned.length).toBeGreaterThan(40);
    expect(models.has('Track')).toBe(true);
    expect(models.has('Album')).toBe(true);
    expect(models.has('UserUpload')).toBe(true);
    expect(models.has('artist')).toBe(true);
    expect(models.has('person')).toBe(true);
  });

  it('includes the constraints this feature depends on', () => {
    loadAllModels();
    const planned = planIndexes();
    const find = (collection: string, spec: Record<string, unknown>) =>
      planned.find(
        (index) =>
          index.collectionName === collection && JSON.stringify(index.spec) === JSON.stringify(spec),
      );

    // Named explicitly because these are the ones whose ABSENCE in production is
    // silent: the code races, nothing errors, and duplicates accumulate.
    expect(find('catalogentities', { nameKey: 1 })?.options.unique).toBe(true);
    expect(find('catalogentities', { linkedOxyUserId: 1 })?.options.unique).toBe(true);
    expect(find('tracks', { 'externalIds.isrc': 1 })?.options.unique).toBe(true);
    expect(find('albums', { 'externalIds.musicbrainzReleaseId': 1 })?.options.unique).toBe(true);
    expect(find('useruploads', { ownerOxyUserId: 1, sha256: 1 })?.options.unique).toBe(true);
    expect(find('useruploads', { fingerprintDurationSec: 1 })).toBeDefined();
  });
});

describe('ensureIndexes — agreement with Mongoose', () => {
  it('builds exactly what Mongoose builds itself', async () => {
    // The script computes the discriminator `partialFilterExpression` by
    // replicating a Mongoose internal. This is the guard on that replication: if
    // Mongoose ever changes the rule, this fails HERE rather than production
    // quietly getting a collection-wide unique index where dev has a
    // discriminator-scoped one.
    await dropAllIndexes('catalogentities');
    await CatalogEntityModel.createIndexes();
    await ArtistModel.createIndexes();
    await PersonModel.createIndexes();
    const byMongoose = await builtIndexDefinitions('catalogentities');

    await dropAllIndexes('catalogentities');
    await ensureIndexes();
    const byScript = await builtIndexDefinitions('catalogentities');

    // Full definitions, so a missing `partialFilterExpression` fails here.
    expect(byScript).toEqual(byMongoose);
    expect(byScript.length).toBeGreaterThan(5);
    // Vacuity floor: the comparison must actually be looking at options.
    expect(byMongoose.some((definition) => definition.includes('partialFilterExpression'))).toBe(true);
  });

  it('scopes a discriminator index to its own type, as Mongoose does', async () => {
    await dropAllIndexes('catalogentities');
    await ensureIndexes();

    const indexes = await mongoose.connection.collection('catalogentities').indexes();
    const nameKeyIndex = indexes.find((index) => index.name === 'nameKey_1');

    // Artist-only. A collection-wide unique index here would make two podcast
    // guests of the same name impossible to store.
    expect(nameKeyIndex?.unique).toBe(true);
    expect(nameKeyIndex?.partialFilterExpression).toMatchObject({ type: 'artist' });
  });
});

describe('ensureIndexes — reporting', () => {
  it('reports what it created, then reports the same indexes as already present', async () => {
    await dropAllIndexes('tracks');

    const first = await ensureIndexes();
    const createdTrackIndexes = first.outcomes.filter(
      (outcome) => outcome.status === 'created' && outcome.index.collectionName === 'tracks',
    );
    expect(createdTrackIndexes.length).toBeGreaterThan(0);
    expect(first.failed).toBe(0);

    // Idempotent: re-running is the normal way to deploy a new index, so the
    // second run must be a no-op rather than an error.
    const second = await ensureIndexes();
    expect(second.created).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.present).toBe(first.outcomes.length);
  });

  it('dry run reports missing indexes WITHOUT building them', async () => {
    await dropAllIndexes('tracks');

    const result = await ensureIndexes({ dryRun: true });
    const missing = result.outcomes.filter(
      (outcome) => outcome.status === 'would-create' && outcome.index.collectionName === 'tracks',
    );

    expect(missing.length).toBeGreaterThan(0);
    expect(result.created).toBe(0);
    // Nothing was written — this is what makes it safe to point at production.
    expect(await builtIndexNames('tracks')).toEqual([]);
  });
});

describe('ensureIndexes — failure on existing duplicate data', () => {
  it('reports the offending documents instead of a bare E11000, and keeps going', async () => {
    // The expected first-run failure against production: a unique index that
    // cannot build because duplicates are ALREADY there. Written through the
    // driver so the schema's own guards do not prevent the bad state.
    await dropAllIndexes('catalogentities');
    await mongoose.connection.collection('catalogentities').insertMany([
      { type: 'artist', name: 'Double Trouble', nameKey: 'double trouble', source: 'upload' },
      { type: 'artist', name: 'Double Trouble', nameKey: 'double trouble', source: 'upload' },
    ]);

    const result = await ensureIndexes();

    const failure = result.outcomes.find(
      (outcome) => outcome.status === 'failed' && JSON.stringify(outcome.index.spec) === '{"nameKey":1}',
    );
    expect(failure).toBeDefined();
    if (failure?.status !== 'failed') throw new Error('expected a failed outcome');

    // "E11000" alone leaves whoever is running the deploy with no next step.
    // The offending group IS the next step.
    expect(failure.duplicates?.length).toBe(1);
    expect(JSON.stringify(failure.duplicates)).toContain('double trouble');
    expect(result.failed).toBeGreaterThan(0);

    // One bad index must not hide the state of the other forty.
    expect(result.created).toBeGreaterThan(0);
    const trackIndexes = await builtIndexNames('tracks');
    expect(trackIndexes.length).toBeGreaterThan(0);
  });

  it('does NOT drop or alter indexes it did not create', async () => {
    // `syncIndexes()` would delete the other discriminators' indexes on this
    // shared collection. This script only ever calls `createIndex`.
    await dropAllIndexes('catalogentities');
    await mongoose.connection
      .collection('catalogentities')
      .createIndex({ bioLengthMarker: 1 }, { name: 'handmade_marker' });

    await ensureIndexes();

    expect(await builtIndexNames('catalogentities')).toContain('handmade_marker');
  });
});

describe('ensureIndexes — the constraints it is meant to restore actually bite', () => {
  it('a unique index built by the script rejects a duplicate afterwards', async () => {
    // Vacuity floor for the whole script: building an index that does not
    // enforce anything would satisfy every test above.
    await dropAllIndexes('tracks');
    await ensureIndexes();

    const track = {
      title: 'A Recording',
      artistId: 'artist-1',
      artistName: 'An Artist',
      duration: 210,
      isAvailable: true,
      source: 'upload' as const,
      externalIds: { isrc: 'USUM71703861' },
    };
    await TrackModel.create(track);
    await expect(TrackModel.create({ ...track, title: 'Same ISRC' })).rejects.toThrow();
  });
});
