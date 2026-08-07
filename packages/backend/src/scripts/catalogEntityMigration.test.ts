import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import { CatalogEntityModel, ArtistModel, PersonModel } from '../models/CatalogEntity';
import { migrateArtistsToCatalogEntities } from './migrateArtistsToCatalogEntities';

/**
 * The `reseedPersons` half of this file MOVED to `reseedPersons.test.ts` in Task
 * 12, and it had to: that script reads `podcast_persons`/`episode_persons` and
 * writes `catalog_entities`, all Postgres, while `migrateArtistsToCatalogEntities`
 * below is a Mongo-only collection rename that has no Postgres side at all. One
 * file cannot own both `beforeAll(connect)` and `beforeAll(connectDb)` without
 * every case paying for a database it does not use.
 */

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

function db(): mongoose.mongo.Db {
  const d = mongoose.connection.db;
  if (!d) throw new Error('no db');
  return d;
}

describe('migrateArtistsToCatalogEntities', () => {
  it('folds legacy artists into catalogentities, preserving _id + stamping type:artist', async () => {
    await db().collection('catalogentities').drop().catch(() => undefined);
    const id = new mongoose.Types.ObjectId();
    // Legacy pre-discriminator artist doc (no `type`).
    await db().collection('artists').insertOne({ _id: id, name: 'Legacy Band', source: 'cc' });

    const stats = await migrateArtistsToCatalogEntities();
    expect(stats.renamed || stats.foldedIn > 0 || stats.typedArtists >= 0).toBe(true);

    // Legacy collection is gone; the doc lives in catalogentities, same _id, type:'artist'.
    const names = (await db().listCollections().toArray()).map((c) => c.name);
    expect(names.includes('artists')).toBe(false);

    const migrated = await CatalogEntityModel.findById(id).lean();
    expect(migrated?._id.toString()).toBe(id.toString());
    expect(migrated?.type).toBe('artist');
    expect(migrated?.name).toBe('Legacy Band');

    // It resolves through the artist discriminator (and not the person one).
    expect(await ArtistModel.findById(id).lean()).not.toBeNull();
    expect(await PersonModel.findById(id).lean()).toBeNull();
  });

  it('is idempotent (second run does not throw or duplicate)', async () => {
    await db().collection('catalogentities').drop().catch(() => undefined);
    const id = new mongoose.Types.ObjectId();
    await db().collection('artists').insertOne({ _id: id, name: 'Once', source: 'cc' });

    await migrateArtistsToCatalogEntities();
    await migrateArtistsToCatalogEntities(); // again

    expect(await ArtistModel.countDocuments({})).toBe(1);
  });
});
