/**
 * One-shot: acoustically index the catalogue that predates the fingerprint write.
 *
 * ## Why this exists
 *
 * `track_fingerprints` is READ in two places and, until recently, was written in
 * none — so both read a permanently empty table:
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
 *   bun run backfill:fingerprints                  # against DATABASE_URL
 *   bun run backfill:fingerprints -- --dry-run     # report what it would do
 *   bun run backfill:fingerprints -- --limit 200   # a bounded first pass
 *
 * It streams every track's audio out of S3 and runs `fpcalc` on it, so it is
 * long-running by nature and WILL be interrupted. That is expected: it skips
 * tracks that already have a row, so re-running RESUMES rather than restarts.
 * There is no checkpoint file, because `track_fingerprints` IS the checkpoint —
 * which is also why a half-finished run needs no cleanup before the next one.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { and, asc, gt, inArray, isNotNull } from 'drizzle-orm';
import dotenv from 'dotenv';
import { describeDriverError, isForeignKeyViolation, sqlStateOf } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { indexTrackAcoustically } from '../db/catalog/fingerprints';
import { trackFingerprints, tracks } from '../db/schema/catalog';
import { logger } from '../utils/logger';
import { streamTrackAudio } from '../services/audioStorageService';
import { fingerprintFile } from '../services/uploads/fingerprint';

dotenv.config();

/**
 * Keyset page size. Small, because each row costs an S3 read plus an `fpcalc`
 * run — this page is a latency budget, not a write budget. The write it feeds
 * is necessarily one row at a time (a fingerprint cannot be computed in bulk),
 * so it is nowhere near the bind-parameter ceiling that constrains the two dump
 * importers, and it stays where Mongo had it.
 */
const BATCH_SIZE = 50;

/**
 * Named, not inferred from the SQLSTATE alone.
 *
 * `23503` on this table means one thing TODAY because `track_id` is the only
 * foreign key on it. A second one added later would raise the same SQLSTATE and
 * be silently recovered as "the track vanished" — so the constraint name is what
 * the recovery is actually keyed on. Taken from a real driver error, not guessed:
 * the generated name is truncated at 63 bytes and this one is 44.
 */
const TRACK_FK = 'track_fingerprints_track_id_tracks_id_fk';

export interface BackfillStats {
  scanned: number;
  indexed: number;
  /** Already had a row — the resumability path, not a problem. */
  skipped: number;
  /** `fpcalc` ran and rejected the audio, or the object could not be read. */
  failed: number;
  /** Refused because the fingerprint was empty — never written, see `db/catalog/fingerprints`. */
  rejected: number;
  /**
   * The track was deleted between this page's `SELECT` and its `INSERT`.
   *
   * New under Postgres and unreachable under Mongo, which had no foreign key:
   * `track_fingerprints.track_id` references `tracks.id`, so a row for a
   * vanished track raises `23503` where Mongo silently stored an orphan.
   * Counted apart from `failed` because nothing is wrong and nothing is worth
   * retrying — the track is gone, and had the fingerprint landed first the
   * cascade would have deleted it anyway. Folding it into `failed` would tell
   * an operator to go and investigate audio that no longer exists.
   */
  vanished: number;
}

export interface BackfillOptions {
  dryRun?: boolean;
  limit?: number;
}

/**
 * The two external effects, injectable for tests.
 *
 * A `mock.module` would be process-GLOBAL in bun and would silently replace S3
 * and `fpcalc` for every other test file in the run — a hazard this codebase has
 * already been bitten by. A parameter is scoped to the call.
 */
export interface BackfillDeps {
  streamAudio: typeof streamTrackAudio;
  fingerprint: typeof fingerprintFile;
}

/**
 * A track as this script needs it — enough for the S3 key and nothing more.
 *
 * Derived from the table rather than hand-written, so a column that changes type
 * is a compile error here instead of a silent `undefined` in the S3 key.
 */
type BackfillTrack = Pick<
  typeof tracks.$inferSelect,
  'id' | 'artistId' | 'albumId' | 'title' | 'audioSourceUrl' | 'audioSourceFormat'
>;

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
  deps: BackfillDeps,
): Promise<'unavailable' | 'continue'> {
  const suffix = track.audioSourceFormat ? `.${track.audioSourceFormat}` : '.audio';
  const stagedPath = path.join(os.tmpdir(), `syra-fp-${track.id}${suffix}`);

  try {
    const { stream } = await deps.streamAudio({
      id: track.id,
      artistId: track.artistId,
      albumId: track.albumId ?? undefined,
      title: track.title,
      audioSource: track.audioSourceUrl
        ? { url: track.audioSourceUrl, format: track.audioSourceFormat ?? undefined }
        : undefined,
    } as Parameters<typeof streamTrackAudio>[0]);

    await pipeline(stream, fs.createWriteStream(stagedPath));

    const result = await deps.fingerprint(stagedPath);

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
      logger.warn(
        `[backfill-fingerprints] unreadable audio, skipping: ${track.id} — ${result.reason}`,
      );
      return 'continue';
    }

    if (options.dryRun) {
      stats.indexed += 1;
      return 'continue';
    }

    const written = await indexTrackAcoustically(track.id, {
      values: result.values,
      durationSec: result.durationSec,
    });

    if (written) stats.indexed += 1;
    else {
      stats.rejected += 1;
      logger.warn(`[backfill-fingerprints] refused an empty fingerprint for ${track.id}`);
    }
  } catch (err) {
    if (isForeignKeyViolation(err, TRACK_FK)) {
      stats.vanished += 1;
      logger.info(
        `[backfill-fingerprints] track ${track.id} was deleted while this run was reading it — nothing to index`,
      );
      return 'continue';
    }

    stats.failed += 1;

    /**
     * A DRIVER error must never be logged whole, and this is the first place in
     * Syra that has to care.
     *
     * postgres.js attaches the failing statement AND its bound parameters, so
     * `logger.warn(…, { err })` publishes the entire fingerprint — measured
     * here as THREE copies of every value: inline in `message`, again in
     * `stack`, and a third time as a structured `params` array. At ~1600 int32s
     * per track, on a catalogue-wide run, that is a log volume problem and a
     * data-in-logs problem at once. Nothing like it existed before the port: a
     * Mongoose error carried no statement.
     *
     * `describeDriverError` reduces it to SQLSTATE, constraint name and error
     * kind — the two things worth reading when a write is refused, neither of
     * which is data.
     *
     * Anything else here is an S3 or `fpcalc` failure, which carries no query
     * and whose detail is the whole point of the log line, so it is unchanged.
     */
    if (sqlStateOf(err) !== undefined) {
      logger.warn(
        `[backfill-fingerprints] the database refused the fingerprint for ${track.id}`,
        { driver: describeDriverError(err) },
      );
    } else {
      logger.warn(`[backfill-fingerprints] could not read audio for ${track.id}`, { err });
    }
  } finally {
    await fs.promises.rm(stagedPath, { force: true }).catch(() => undefined);
  }

  return 'continue';
}

export async function backfillTrackFingerprints(
  options: BackfillOptions = {},
  deps: BackfillDeps = { streamAudio: streamTrackAudio, fingerprint: fingerprintFile },
): Promise<BackfillStats> {
  const stats: BackfillStats = {
    scanned: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
    rejected: 0,
    vanished: 0,
  };
  let lastId: string | undefined;

  for (;;) {
    if (options.limit !== undefined && stats.scanned >= options.limit) break;

    /**
     * Keyset pagination on the primary key, as it was on `_id`. `generatedId`
     * mints UUIDv7, whose text ordering is its mint ordering, so `id > $1` walks
     * the table once on `tracks_pkey` with no offset scan.
     */
    const batch = await getDb()
      .select({
        id: tracks.id,
        artistId: tracks.artistId,
        albumId: tracks.albumId,
        title: tracks.title,
        audioSourceUrl: tracks.audioSourceUrl,
        audioSourceFormat: tracks.audioSourceFormat,
      })
      .from(tracks)
      .where(
        lastId === undefined
          ? isNotNull(tracks.audioSourceUrl)
          : and(isNotNull(tracks.audioSourceUrl), gt(tracks.id, lastId)),
      )
      .orderBy(asc(tracks.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    // One query per BATCH rather than per track: the skip check is the common
    // case on a resumed run, and doing it per row would make resuming as slow as
    // the original pass.
    const alreadyIndexed = new Set(
      (
        await getDb()
          .select({ trackId: trackFingerprints.trackId })
          .from(trackFingerprints)
          .where(
            inArray(
              trackFingerprints.trackId,
              batch.map((track) => track.id),
            ),
          )
      ).map((row) => row.trackId),
    );

    for (const track of batch) {
      if (options.limit !== undefined && stats.scanned >= options.limit) break;
      stats.scanned += 1;

      if (alreadyIndexed.has(track.id)) {
        stats.skipped += 1;
        continue;
      }

      if ((await fingerprintOne(track, stats, options, deps)) === 'unavailable') return stats;
    }

    lastId = batch[batch.length - 1]?.id;
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

  await connectPostgres();
  logger.info(
    `[backfill-fingerprints] starting${dryRun ? ' (dry run — nothing will be written)' : ''}` +
      `${limit !== undefined ? ` (limit ${limit})` : ''}`,
  );

  const stats = await backfillTrackFingerprints({ dryRun, limit });

  logger.info(
    `[backfill-fingerprints] ${stats.scanned} scanned | ${stats.indexed} indexed | ` +
      `${stats.skipped} already had a row | ${stats.failed} unreadable | ` +
      `${stats.rejected} empty-refused | ${stats.vanished} deleted mid-run`,
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
    .then(() => closePostgres())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[backfill-fingerprints] fatal', { err });
      closePostgres().finally(() => process.exit(1));
    });
}
