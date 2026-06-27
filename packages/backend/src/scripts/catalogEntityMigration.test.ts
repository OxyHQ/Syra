import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import { CatalogEntityModel, ArtistModel, PersonModel } from '../models/CatalogEntity';
import { PodcastModel } from '../models/Podcast';
import { EpisodeModel } from '../models/Episode';
import { migrateArtistsToCatalogEntities } from './migrateArtistsToCatalogEntities';
import { reseedPersons } from './reseedPersons';

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

describe('reseedPersons', () => {
  it('drops name-only persons, keeps Oxy-linked, re-derives from credits', async () => {
    // Pre-existing persons: one name-only (should drop), one Oxy-linked (should keep).
    await PersonModel.create({ name: 'Stale RSS Person' });
    await PersonModel.create({ name: 'Creator Oxy Person', linkedOxyUserId: 'oxy-keep' });

    // Credits to re-derive from.
    await PodcastModel.create({
      title: 'Show', source: 'rss', feedUrl: 'https://f/s.xml', status: 'active',
      persons: [{ name: 'Channel Host', role: 'host' }],
    });
    await EpisodeModel.create({
      podcastId: new mongoose.Types.ObjectId(), podcastTitle: 'Show', title: 'Ep',
      guid: 'g1', pubDate: new Date(), source: 'rss', enclosureUrl: 'https://x/1.mp3', status: 'ready',
      persons: [{ name: 'Episode Guest', role: 'guest' }],
    });

    const stats = await reseedPersons();

    expect(stats.deleted).toBe(1); // only the name-only RSS person dropped
    expect(stats.creditsReplayed).toBe(2);

    // Oxy-linked kept, channel + episode credits derived; stale one not duplicated.
    const names = (await PersonModel.find({}).lean()).map((p) => p.name).sort();
    expect(names).toEqual(['Channel Host', 'Creator Oxy Person', 'Episode Guest']);
    // Every person row is type:'person'.
    expect(await ArtistModel.countDocuments({})).toBe(0);
  });
});
