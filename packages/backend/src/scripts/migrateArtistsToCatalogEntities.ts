/**
 * One-shot migration: fold the legacy `artists` collection into the unified
 * `catalogentities` collection (the CatalogEntity discriminator base) and stamp
 * every existing artist with `type:'artist'`.
 *
 * Artist `_id`s are PRESERVED (rename, not reseed) so `Track.artistId`,
 * `Album.artistId`, `Playlist`, `Podcast.linkedArtistId`, etc. keep resolving.
 *
 * IDEMPOTENT — safe to run repeatedly:
 *  - `artists` exists, `catalogentities` missing → `renameCollection`.
 *  - both exist (app already wrote catalogentities) → upsert legacy docs by _id,
 *    then drop `artists`.
 *  - finally stamp `type:'artist'` on any pre-discriminator docs missing `type`.
 *
 * Run as an ECS one-shot: `bun run src/scripts/migrateArtistsToCatalogEntities.ts`
 * with the production MONGODB_URI in the environment. Run BEFORE `reseedPersons`.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';

dotenv.config();

export interface MigrateArtistsStats {
  renamed: boolean;
  foldedIn: number;
  typedArtists: number;
}

/** MongoServerError code 48 — rename target collection already exists. */
function isNamespaceExists(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as { code: unknown }).code === 48;
}

/** Upsert every legacy `artists` doc into `catalogentities` by _id, then drop `artists`. */
async function foldLegacyArtistsIn(db: mongoose.mongo.Db): Promise<number> {
  const legacy = db.collection('artists');
  const target = db.collection('catalogentities');
  const docs = await legacy.find({}).toArray();
  let foldedIn = 0;
  for (const doc of docs) {
    const result = await target.updateOne(
      { _id: doc._id },
      { $setOnInsert: { ...doc, type: doc.type ?? 'artist' } },
      { upsert: true },
    );
    if (result.upsertedCount > 0) foldedIn += 1;
  }
  await legacy.drop();
  return foldedIn;
}

export async function migrateArtistsToCatalogEntities(): Promise<MigrateArtistsStats> {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('migrateArtistsToCatalogEntities: no active database connection');
  }

  const names = (await db.listCollections().toArray()).map((c) => c.name);
  let renamed = false;
  let foldedIn = 0;

  if (names.includes('artists')) {
    if (names.includes('catalogentities')) {
      // App already writing catalogentities (the common live-migration case) — fold in.
      foldedIn = await foldLegacyArtistsIn(db);
    } else {
      try {
        await db.collection('artists').rename('catalogentities');
        renamed = true;
      } catch (err) {
        // Race: the model recreated catalogentities between listing and rename.
        if (!isNamespaceExists(err)) throw err;
        foldedIn = await foldLegacyArtistsIn(db);
      }
    }
  }

  // Stamp type:'artist' on any pre-discriminator artist docs that lack it.
  const typed = await db
    .collection('catalogentities')
    .updateMany({ type: { $exists: false } }, { $set: { type: 'artist' } });

  return { renamed, foldedIn, typedArtists: typed.modifiedCount };
}

async function main(): Promise<void> {
  await connectToDatabase();
  logger.info('[migrate-catalog] starting artists → catalogentities migration');
  const stats = await migrateArtistsToCatalogEntities();
  logger.info('[migrate-catalog] complete', { ...stats });
}

if (require.main === module) {
  main()
    .then(() => mongoose.connection.close())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[migrate-catalog] fatal error', { err });
      mongoose.connection.close().finally(() => process.exit(1));
    });
}
