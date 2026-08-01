/**
 * One-shot: acoustically index the catalogue that predates the fingerprint write.
 *
 * ## Why this exists
 *
 * `TrackFingerprint` is READ in two places and, until recently, was written in
 * none — so both read a permanently empty collection:
 *
 *  - `matchCatalog` tier 3 compares an upload's fingerprint against the
 *    catalogue. With no rows it always abstains, so the acoustic dedup tier is a
 *    no-op on every upload.
 *  - The takedown purge finds locker copies of a taken-down recording that hash
 *    differently, i.e. RE-ENCODES. With no rows it degrades to `sha256`-only and
 *    misses every one of them, which is the safe-harbour leg.
 *
 * The publish path now writes a row per new track. This script covers everything
 * that already existed. Until it has run, both behaviours above are inert for
 * the existing catalogue no matter how correct their code is.
 *
 * ## Running it
 *
 *   bun run backfill:fingerprints                  # against MONGODB_URI
 *   bun run backfill:fingerprints -- --dry-run     # report what it would do
 *   bun run backfill:fingerprints -- --limit 200   # a bounded first pass
 *
 * It streams every track's audio out of S3 and runs `fpcalc` on it, so it is
 * long-running by nature and WILL be interrupted. That is expected: it skips
 * tracks that already have a row, so re-running resumes rather than restarts.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';
import { TrackModel } from '../models/Track';
import { TrackFingerprintModel, indexTrackAcoustically } from '../models/TrackFingerprint';
import { streamTrackAudio } from '../services/audioStorageService';
import { fingerprintFile } from '../services/uploads/fingerprint';

dotenv.config();

/** Keyset page size. Small, because each row costs an S3 read plus an `fpcalc` run. */
const BATCH_SIZE = 50;

export interface BackfillStats {
  scanned: number;
  indexed: number;
  /** Already had a row — the resumability path, not a problem. */
  skipped: number;
  /** `fpcalc` ran and rejected the audio, or the object could not be read. */
  failed: number;
  /** Refused because the fingerprint was empty — never written, see the model. */
  rejected: number;
}

export interface BackfillOptions {
  dryRun?: boolean;
  limit?: number;
}

/** A track as this script needs it — enough for the S3 key and nothing more. */
interface BackfillTrack {
  _id: mongoose.Types.ObjectId;
  artistId: string;
  albumId?: string;
  title: string;
  audioSource?: { url: string; format: string };
}

/**
 * Fingerprint ONE track: stream it out of S3 to a temp file, run `fpcalc`, write.
 *
 * `fpcalc` needs a real path — it seeks — so the object cannot simply be piped
 * through. The temp file is removed in `finally`, including on the failure
 * paths, because a long backfill that leaks one file per track fills the disk of
 * the box it is running on somewhere around track forty thousand.
 */
async function fingerprintOne(
  track: BackfillTrack,
  stats: BackfillStats,
  options: BackfillOptions,
): Promise<'unavailable' | 'continue'> {
  const trackId = track._id.toString();
  const suffix = track.audioSource?.format ? `.${track.audioSource.format}` : '.audio';
  const stagedPath = path.join(os.tmpdir(), `syra-fp-${trackId}${suffix}`);

  try {
    const { stream } = await streamTrackAudio({
      id: trackId,
      artistId: track.artistId,
      albumId: track.albumId,
      title: track.title,
      audioSource: track.audioSource,
    } as Parameters<typeof streamTrackAudio>[0]);

    await pipeline(stream, fs.createWriteStream(stagedPath));

    const result = await fingerprintFile(stagedPath);

    if (result.status === 'unavailable') {
      /**
       * `fpcalc` missing is an ENVIRONMENT problem, not a per-track one, so
       * there is no value in discovering it forty thousand more times. Stop and
       * say so — a run that "completed" having indexed nothing because the
       * binary was absent is the worst possible outcome, since the counts would
       * look like the catalogue simply had no fingerprintable audio.
       */
      logger.error(`[backfill-fingerprints] ABORTING — ${result.reason}`);
      return 'unavailable';
    }

    if (result.status === 'failed') {
      stats.failed += 1;
      logger.warn(`[backfill-fingerprints] unreadable audio, skipping: ${trackId} — ${result.reason}`);
      return 'continue';
    }

    if (options.dryRun) {
      stats.indexed += 1;
      return 'continue';
    }

    const written = await indexTrackAcoustically(trackId, {
      values: result.values,
      durationSec: result.durationSec,
    });

    if (written) stats.indexed += 1;
    else {
      stats.rejected += 1;
      logger.warn(`[backfill-fingerprints] refused an empty fingerprint for ${trackId}`);
    }
  } catch (err) {
    stats.failed += 1;
    logger.warn(`[backfill-fingerprints] could not read audio for ${trackId}`, { err });
  } finally {
    await fs.promises.rm(stagedPath, { force: true }).catch(() => undefined);
  }

  return 'continue';
}

export async function backfillTrackFingerprints(options: BackfillOptions = {}): Promise<BackfillStats> {
  const stats: BackfillStats = { scanned: 0, indexed: 0, skipped: 0, failed: 0, rejected: 0 };
  let lastId: mongoose.Types.ObjectId | undefined;

  for (;;) {
    if (options.limit !== undefined && stats.scanned >= options.limit) break;

    const batch = await TrackModel.find(
      {
        'audioSource.url': { $exists: true },
        ...(lastId ? { _id: { $gt: lastId } } : {}),
      },
      { artistId: 1, albumId: 1, title: 1, audioSource: 1 },
    )
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean<BackfillTrack[]>();

    if (batch.length === 0) break;

    // One query per BATCH rather than per track: the skip check is the common
    // case on a resumed run, and doing it per row would make resuming as slow as
    // the original pass.
    const alreadyIndexed = new Set(
      (
        await TrackFingerprintModel.find(
          { trackId: { $in: batch.map((track) => track._id.toString()) } },
          { trackId: 1 },
        ).lean<Array<{ trackId: string }>>()
      ).map((row) => row.trackId),
    );

    for (const track of batch) {
      if (options.limit !== undefined && stats.scanned >= options.limit) break;
      stats.scanned += 1;

      if (alreadyIndexed.has(track._id.toString())) {
        stats.skipped += 1;
        continue;
      }

      if ((await fingerprintOne(track, stats, options)) === 'unavailable') return stats;
    }

    lastId = batch[batch.length - 1]?._id;
  }

  return stats;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const limitFlag = process.argv.indexOf('--limit');

  /**
   * A malformed `--limit` is refused, not ignored.
   *
   * `Number(undefined)` is `NaN`, and every `scanned >= NaN` comparison is
   * false — so `--limit` with a missing or non-numeric value would silently
   * become UNLIMITED and start a full catalogue pass. That is the opposite of
   * what somebody typing `--limit` wants, and they would find out by watching it
   * stream the entire catalogue out of S3.
   */
  let limit: number | undefined;
  if (limitFlag !== -1) {
    limit = Number(process.argv[limitFlag + 1]);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error(
        `--limit needs a non-negative whole number, got ${JSON.stringify(process.argv[limitFlag + 1])}. ` +
          'Refusing to run: an unparseable limit would otherwise mean no limit at all.',
      );
    }
  }

  await connectToDatabase();
  logger.info(
    `[backfill-fingerprints] starting${dryRun ? ' (dry run — nothing will be written)' : ''}` +
      `${limit !== undefined ? ` (limit ${limit})` : ''}`,
  );

  const stats = await backfillTrackFingerprints({ dryRun, limit });

  logger.info(
    `[backfill-fingerprints] ${stats.scanned} scanned | ${stats.indexed} indexed | ` +
      `${stats.skipped} already had a row | ${stats.failed} unreadable | ${stats.rejected} empty-refused`,
  );

  if (stats.failed > 0) {
    logger.warn(
      `[backfill-fingerprints] ${stats.failed} track(s) could not be fingerprinted. They stay ` +
        'invisible to acoustic dedup and to the re-encode leg of the takedown purge. Re-running ' +
        'retries only those, since indexed tracks are skipped.',
    );
  }
}

if (require.main === module) {
  main()
    .then(() => mongoose.connection.close())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[backfill-fingerprints] fatal', { err });
      mongoose.connection.close().finally(() => process.exit(1));
    });
}
