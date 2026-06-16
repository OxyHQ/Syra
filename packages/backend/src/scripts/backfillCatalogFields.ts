/**
 * Backfill script: set source/status on catalog docs that pre-date multi-source support.
 *
 * All existing documents were created via artist upload, so they receive
 * source='upload'. Tracks additionally receive status='ready' (they were
 * already fully transcoded at time of upload).
 *
 * Idempotent: uses $exists:false filters, so re-running is safe.
 *
 * Run manually after deploying the schema migration:
 *   MONGODB_URI=<uri> bun run packages/backend/src/scripts/backfillCatalogFields.ts
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectToDatabase } from '../utils/database';
import { TrackModel } from '../models/Track';
import { ArtistModel } from '../models/Artist';
import { logger } from '../utils/logger';

dotenv.config();

async function backfillCatalogFields(): Promise<void> {
  await connectToDatabase();
  logger.info('[backfill] Connected to MongoDB');

  const trackResult = await TrackModel.updateMany(
    { source: { $exists: false } },
    { $set: { source: 'upload', status: 'ready' } },
  );
  logger.info(`[backfill] Tracks patched: ${trackResult.modifiedCount} (matched ${trackResult.matchedCount})`);

  const artistResult = await ArtistModel.updateMany(
    { source: { $exists: false } },
    { $set: { source: 'upload' } },
  );
  logger.info(`[backfill] Artists patched: ${artistResult.modifiedCount} (matched ${artistResult.matchedCount})`);

  logger.info('[backfill] Done.');
}

backfillCatalogFields()
  .then(() => mongoose.connection.close())
  .catch((err) => {
    logger.error('[backfill] Fatal error:', err);
    mongoose.connection.close();
    process.exit(1);
  });
