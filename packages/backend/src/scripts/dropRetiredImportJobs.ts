/**
 * One-shot production cleanup: drop the `importjobs` collection, left orphaned
 * when the external-catalog import pipeline was removed.
 *
 * REVIEW BEFORE RUNNING. DRY-RUN by default; only writes when passed `--apply`:
 *
 *   bun run src/scripts/dropRetiredImportJobs.ts            # report only
 *   bun run src/scripts/dropRetiredImportJobs.ts --apply    # drop the collection
 *
 * Deliberately SEPARATE from `purgeAudiusData` rather than folded into it. These
 * job records are not Audius data — `ImportJob` logged runs of the external
 * import pipeline for every provider, CC included — so putting them behind a
 * script named "purge Audius" would misdescribe what it deletes. Two honest
 * scripts beat one whose name only covers half its behaviour.
 *
 * Background: Syra is a creator-upload catalogue. `services/sources` (the
 * connectors and `importService`) and the `services/catalog` upsert layer it
 * drove were removed, taking the `ImportJob` model with them. A collection with
 * no model is the same class of half-state as a model with no caller — it
 * survives migrations, shows up in backups, and confuses whoever finds it next.
 *
 * Nothing reads this collection any more, so dropping it is safe. It is
 * nonetheless a destructive production action and stays the owner's call.
 */
import mongoose from 'mongoose';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';

const COLLECTION = 'importjobs';

export interface ImportJobFootprint {
  exists: boolean;
  documents: number;
  providers: Record<string, number>;
}

function db(): mongoose.mongo.Db {
  const conn = mongoose.connection.db;
  if (!conn) {
    throw new Error('dropRetiredImportJobs: no database connection');
  }
  return conn;
}

/** Report what is there, without writing. */
export async function reportImportJobFootprint(): Promise<ImportJobFootprint> {
  const d = db();
  const collections = await d.listCollections({ name: COLLECTION }).toArray();
  if (collections.length === 0) {
    return { exists: false, documents: 0, providers: {} };
  }

  const documents = await d.collection(COLLECTION).countDocuments();
  const grouped = await d
    .collection(COLLECTION)
    .aggregate<{ _id: string | null; n: number }>([{ $group: { _id: '$provider', n: { $sum: 1 } } }])
    .toArray();

  const providers: Record<string, number> = {};
  for (const row of grouped) {
    providers[row._id ?? 'unknown'] = row.n;
  }

  return { exists: true, documents, providers };
}

export async function dropImportJobs(): Promise<boolean> {
  const d = db();
  const collections = await d.listCollections({ name: COLLECTION }).toArray();
  if (collections.length === 0) return false;
  await d.collection(COLLECTION).drop();
  return true;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await connectToDatabase();

  const footprint = await reportImportJobFootprint();
  logger.info('[drop-import-jobs] footprint (nothing written yet)', { ...footprint });

  if (!footprint.exists) {
    logger.info('[drop-import-jobs] collection does not exist — nothing to do');
    return;
  }

  if (!apply) {
    logger.info('[drop-import-jobs] DRY RUN — re-run with --apply to drop the collection');
    return;
  }

  const dropped = await dropImportJobs();
  logger.info('[drop-import-jobs] complete', { dropped, documents: footprint.documents });
}

if (require.main === module) {
  main()
    .then(() => mongoose.connection.close())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[drop-import-jobs] fatal error', { err });
      mongoose.connection.close().finally(() => process.exit(1));
    });
}
