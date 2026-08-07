/**
 * Import the ISRC slice of the MusicBrainz database into `isrc_registry`.
 *
 * WHAT THIS IS FOR
 * An ISRC on an uploaded file proves nothing on its own — indie distributors
 * assign them, so every independent artist arrives carrying one. What tells us a
 * file is a known commercial release is the ISRC RESOLVING to a catalogued
 * recording with releases behind it. This table is that resolution, held locally
 * so screening is a point query rather than a paid web-service call.
 *
 * WHAT READS IT — and why an empty table is not a quiet failure.
 * `services/uploads/isrcLookup.ts` resolves an uploader-supplied ISRC here,
 * `provenanceSignals.ts` scores it, `acoustid.ts` runs the join in reverse
 * (recording MBID → ISRC) and `resolveArtist.ts` takes the credited artist from
 * it. All four answer "not a known commercial release" when the table is empty,
 * which is indistinguishable from a real negative. Until this has run, they are
 * confidently wrong rather than visibly broken.
 *
 * WHERE THE DATA COMES FROM
 * MusicBrainz's full data export, which is CC0 and free to redistribute:
 *
 *   https://data.metabrainz.org/pub/musicbrainz/data/fullexport/
 *
 * `LATEST` in that directory names the current dump; the core tables live in
 * `mbdump.tar.bz2` (~4 GB compressed, ~20 GB extracted). Download and extract it
 * yourself — this script deliberately does NOT fetch 4 GB over the network on
 * its own, because an import that re-downloads on every retry is an import
 * nobody can retry:
 *
 *   LATEST=$(curl -s https://data.metabrainz.org/pub/musicbrainz/data/fullexport/LATEST)
 *   curl -O "https://data.metabrainz.org/pub/musicbrainz/data/fullexport/$LATEST/mbdump.tar.bz2"
 *   tar -xjf mbdump.tar.bz2          # yields ./mbdump/<table> plus ./TIMESTAMP
 *   bun run src/scripts/importIsrcRegistry.ts --dump-dir ./mbdump
 *
 * HOW OFTEN
 * Monthly. MetaBrainz publishes full exports roughly twice a week; the registry
 * only needs to be fresh enough to recognise established commercial releases, and
 * a brand-new release is caught by the other markers rather than by this one.
 *
 * FORMAT
 * The dump files are PostgreSQL `COPY … TO` text output: tab-separated, one row
 * per line, `\N` for NULL, and backslash escapes for tabs, newlines and
 * backslashes inside values. Column order is the `CREATE TABLE` order in
 * `admin/sql/CreateTables.sql`, which is what {@link ISRC_COLUMNS} and friends
 * below encode. Verified against the 2026-08-01 export.
 *
 * IDEMPOTENT AND RESUMABLE
 * Every write is an `ON CONFLICT DO UPDATE` against `isrc_registry_isrc_key`, so
 * a second run over the same dump changes nothing and a run over a newer dump
 * updates in place — the real unique constraint decides, never a read-then-write
 * race. A checkpoint file records how many `isrc` rows have been committed
 * together with the dump's own TIMESTAMP, so an interrupted import resumes where
 * it stopped — and REFUSES to resume against a different dump, where a row
 * offset would point somewhere else entirely.
 *
 * PARTIAL FAILURE: RESUME, not redo. Each flush is one transaction and the
 * checkpoint is written only after it commits, so a crash costs at most the
 * batch in flight. Re-running that batch is harmless because the upsert is
 * idempotent, which is what makes "resume" safe rather than merely cheap.
 *
 * THE DUMP IS AUTHORITATIVE — a deliberate change from Mongo. `lengthMs` is
 * absent from a row whose recording has no length, and the conflict `SET` writes
 * `excluded.length_ms`, so re-importing a dump that dropped a length CLEARS the
 * stored one. Mongo's `$set` omitted the key and the stale value survived
 * forever. This is a mirror of somebody else's dataset: when the source stops
 * asserting a fact, the mirror must stop asserting it too.
 *
 * MEMORY
 * The join is held in memory: ~3.5M recordings that carry an ISRC, plus the
 * artist credits they reference. Budget ~2 GB of heap; run with
 * `--skip-release-counts` on a smaller box to drop the `track` pass, at the cost
 * of every `releaseCount` importing as 0 (which downgrades the screening marker
 * from blocking to high — see `provenanceSignals.ts`).
 */

import { sql } from 'drizzle-orm';
import { normalizeNameKey } from '@syra/shared-types';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { isrcRegistry } from '../db/schema/catalog';
import { logger } from '../utils/logger';
import {
  chunkForBindParams,
  IdBitmap,
  IdCounter,
  loadCheckpoint,
  parseDumpArgs,
  readDumpTable,
  readDumpTimestamp,
  unescapeCopyValue,
  writeCheckpoint,
  type DumpImportOptions,
} from './dumpImport';

// ── Dump column layout (admin/sql/CreateTables.sql) ─────────────────────────

/** `isrc`: id, recording, isrc, edits_pending, created */
const ISRC_COLUMNS = { recording: 1, isrc: 2 } as const;

/** `recording`: id, gid, name, artist_credit, length, comment, edits_pending, last_updated, video */
const RECORDING_COLUMNS = { id: 0, gid: 1, name: 2, artistCredit: 3, length: 4 } as const;

/** `artist_credit`: id, name, artist_count, ref_count, created, edits_pending, gid */
const ARTIST_CREDIT_COLUMNS = { id: 0, name: 1 } as const;

/** `track`: id, gid, recording, medium, position, number, name, artist_credit, … */
const TRACK_COLUMNS = { recording: 2 } as const;

interface RecordingRow {
  gid: string;
  title: string;
  artistCreditId: number;
  lengthMs?: number;
}

/**
 * Worst-case bind parameters per `isrc_registry` row: the seven columns this
 * importer writes, plus the client-minted `id`. `created_at`/`updated_at` cost
 * nothing — they carry SQL defaults, so drizzle emits the `default` keyword
 * rather than a parameter.
 */
const ISRC_BIND_PARAMS_PER_ROW = 8;

// ── Passes ──────────────────────────────────────────────────────────────────

async function collectRecordingsWithIsrc(dumpDir: string): Promise<IdBitmap> {
  const bitmap = new IdBitmap();
  let rows = 0;
  for await (const columns of readDumpTable(dumpDir, 'isrc')) {
    const recording = Number(columns[ISRC_COLUMNS.recording]);
    if (Number.isFinite(recording)) bitmap.set(recording);
    rows += 1;
  }
  logger.info(`isrc: ${rows} rows`);
  return bitmap;
}

async function collectRecordings(
  dumpDir: string,
  wanted: IdBitmap,
): Promise<{ recordings: Map<number, RecordingRow>; artistCredits: IdBitmap }> {
  const recordings = new Map<number, RecordingRow>();
  const artistCredits = new IdBitmap();

  for await (const columns of readDumpTable(dumpDir, 'recording')) {
    const id = Number(columns[RECORDING_COLUMNS.id]);
    if (!Number.isFinite(id) || !wanted.has(id)) continue;

    const gid = unescapeCopyValue(columns[RECORDING_COLUMNS.gid]);
    const title = unescapeCopyValue(columns[RECORDING_COLUMNS.name]);
    const artistCreditId = Number(columns[RECORDING_COLUMNS.artistCredit]);
    if (!gid || !title || !Number.isFinite(artistCreditId)) continue;

    const lengthRaw = unescapeCopyValue(columns[RECORDING_COLUMNS.length]);
    const lengthMs = lengthRaw === undefined ? undefined : Number(lengthRaw);

    recordings.set(id, {
      gid,
      title,
      artistCreditId,
      ...(lengthMs !== undefined && Number.isFinite(lengthMs) && { lengthMs }),
    });
    artistCredits.set(artistCreditId);
  }

  logger.info(`recording: ${recordings.size} rows carrying an ISRC`);
  return { recordings, artistCredits };
}

async function collectArtistCredits(
  dumpDir: string,
  wanted: IdBitmap,
): Promise<Map<number, string>> {
  const credits = new Map<number, string>();
  for await (const columns of readDumpTable(dumpDir, 'artist_credit')) {
    const id = Number(columns[ARTIST_CREDIT_COLUMNS.id]);
    if (!Number.isFinite(id) || !wanted.has(id)) continue;
    const name = unescapeCopyValue(columns[ARTIST_CREDIT_COLUMNS.name]);
    if (name) credits.set(id, name);
  }
  logger.info(`artist_credit: ${credits.size} referenced credits`);
  return credits;
}

/**
 * Count how many release tracks reference each recording.
 *
 * A `track` row is one appearance of a recording on one medium of one release,
 * so this over-counts a release pressed on two discs. That is fine for what the
 * number is used for — it is a "how widely distributed is this" proxy, and the
 * screening rule only asks whether it is above zero.
 */
async function countReleaseAppearances(dumpDir: string, wanted: IdBitmap): Promise<IdCounter> {
  const counts = new IdCounter();
  for await (const columns of readDumpTable(dumpDir, 'track')) {
    const recording = Number(columns[TRACK_COLUMNS.recording]);
    if (Number.isFinite(recording) && wanted.has(recording)) counts.increment(recording);
  }
  return counts;
}

// ── Import ──────────────────────────────────────────────────────────────────

export interface ImportOptions extends DumpImportOptions {
  skipReleaseCounts: boolean;
}

export interface ImportSummary {
  isrcRowsRead: number;
  rowsWritten: number;
  skippedResumed: number;
  skippedUnresolved: number;
}

export async function importIsrcRegistry(options: ImportOptions): Promise<ImportSummary> {
  const dumpTimestamp = readDumpTimestamp(options.dumpDir);
  const alreadyCommitted = loadCheckpoint(options.checkpointPath, dumpTimestamp);
  if (alreadyCommitted > 0) {
    logger.info(`resuming dump ${dumpTimestamp} after ${alreadyCommitted} committed isrc rows`);
  }

  const recordingsWithIsrc = await collectRecordingsWithIsrc(options.dumpDir);
  const { recordings, artistCredits } = await collectRecordings(options.dumpDir, recordingsWithIsrc);
  const credits = await collectArtistCredits(options.dumpDir, artistCredits);
  const releaseCounts = options.skipReleaseCounts
    ? undefined
    : await countReleaseAppearances(options.dumpDir, recordingsWithIsrc);

  const summary: ImportSummary = {
    isrcRowsRead: 0,
    rowsWritten: 0,
    skippedResumed: 0,
    skippedUnresolved: 0,
  };

  type RegistryRow = typeof isrcRegistry.$inferInsert;

  /**
   * Keyed by `isrc`, NOT an array — and that is load-bearing rather than tidy.
   *
   * MusicBrainz's `isrc` table maps recordings to identifiers many-to-many, so
   * the same ISRC legitimately appears on more than one recording and reaches
   * this batch twice. Mongo's `bulkWrite` applied those as two sequential
   * `updateOne`s and the last one won. Postgres refuses outright: two rows with
   * the same conflict key in ONE `INSERT … ON CONFLICT DO UPDATE` is
   * `21000 — ON CONFLICT DO UPDATE command cannot affect row a second time`,
   * which fails the whole statement and therefore the whole import.
   *
   * A `Map` keeps last-write-wins, matching what Mongo did, and guarantees the
   * conflict key is unique within every statement this builds.
   */
  let batch = new Map<string, RegistryRow>();

  const flush = async (rowsCoveredByBatch: number): Promise<void> => {
    if (batch.size > 0) {
      const rows = [...batch.values()];
      /**
       * One transaction per flush, so the checkpoint written below can never
       * claim rows that a crash left half-applied.
       */
      await getDb().transaction(async (tx) => {
        for (const chunk of chunkForBindParams(rows, ISRC_BIND_PARAMS_PER_ROW)) {
          await tx
            .insert(isrcRegistry)
            .values(chunk)
            .onConflictDoUpdate({
              target: isrcRegistry.isrc,
              set: {
                recordingMbid: sql`excluded.recording_mbid`,
                title: sql`excluded.title`,
                artistCredit: sql`excluded.artist_credit`,
                artistCreditNameKey: sql`excluded.artist_credit_name_key`,
                lengthMs: sql`excluded.length_ms`,
                releaseCount: sql`excluded.release_count`,
              },
            });
        }
      });
      summary.rowsWritten += rows.length;
      batch = new Map();
    }
    writeCheckpoint(options.checkpointPath, { dumpTimestamp, committedRows: rowsCoveredByBatch });
  };

  for await (const columns of readDumpTable(options.dumpDir, 'isrc')) {
    summary.isrcRowsRead += 1;
    if (summary.isrcRowsRead <= alreadyCommitted) {
      summary.skippedResumed += 1;
      continue;
    }

    const isrc = unescapeCopyValue(columns[ISRC_COLUMNS.isrc])?.toUpperCase();
    const recordingId = Number(columns[ISRC_COLUMNS.recording]);
    const recording = Number.isFinite(recordingId) ? recordings.get(recordingId) : undefined;
    const artistCredit = recording ? credits.get(recording.artistCreditId) : undefined;

    // A row whose recording or credit did not resolve is dropped rather than
    // written with a placeholder: the whole value of this collection is that a
    // hit means "a real catalogued release", so a half-populated row would make
    // the screening marker fire on nothing.
    if (!isrc || !recording || !artistCredit) {
      summary.skippedUnresolved += 1;
      continue;
    }

    batch.set(isrc, {
      isrc,
      recordingMbid: recording.gid,
      title: recording.title,
      artistCredit,
      artistCreditNameKey: normalizeNameKey(artistCredit),
      releaseCount: releaseCounts?.get(recordingId) ?? 0,
      ...(recording.lengthMs !== undefined && { lengthMs: recording.lengthMs }),
    });

    if (batch.size >= options.batchSize) {
      await flush(summary.isrcRowsRead);
      logger.info(`isrc: ${summary.rowsWritten} rows written`);
    }
  }

  await flush(summary.isrcRowsRead);
  return summary;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseDumpArgs(process.argv.slice(2), {
    script: 'importIsrcRegistry',
    defaultCheckpoint: '.isrc-import-checkpoint.json',
  });
  const options: ImportOptions = {
    ...parsed,
    skipReleaseCounts: parsed.flags.has('skip-release-counts'),
  };
  await connectPostgres();
  try {
    const summary = await importIsrcRegistry(options);
    logger.info(
      `ISRC registry import complete: read ${summary.isrcRowsRead} rows, wrote ${summary.rowsWritten}, ` +
        `resumed past ${summary.skippedResumed}, dropped ${summary.skippedUnresolved} unresolved`,
    );
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    logger.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
