/**
 * Import the ISRC slice of the MusicBrainz database into `IsrcRegistry`.
 *
 * WHAT THIS IS FOR
 * An ISRC on an uploaded file proves nothing on its own — indie distributors
 * assign them, so every independent artist arrives carrying one. What tells us a
 * file is a known commercial release is the ISRC RESOLVING to a catalogued
 * recording with releases behind it. This collection is that resolution, held
 * locally so screening is a point query rather than a paid web-service call.
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
 * Every write is an `updateOne` upsert keyed on `isrc`, so a second run over the
 * same dump changes nothing and a run over a newer dump updates in place. A
 * checkpoint file records how many `isrc` rows have been committed together with
 * the dump's own TIMESTAMP, so an interrupted import resumes where it stopped —
 * and REFUSES to resume against a different dump, where a row offset would point
 * somewhere else entirely.
 *
 * MEMORY
 * The join is held in memory: ~3.5M recordings that carry an ISRC, plus the
 * artist credits they reference. Budget ~2 GB of heap; run with
 * `--skip-release-counts` on a smaller box to drop the `track` pass, at the cost
 * of every `releaseCount` importing as 0 (which downgrades the screening marker
 * from blocking to high — see `provenanceSignals.ts`).
 */

import mongoose from 'mongoose';
import { normalizeNameKey } from '@syra/shared-types';
import { IsrcRegistryModel } from '../models/IsrcRegistry';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';
import {
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
  documentsWritten: number;
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
    documentsWritten: 0,
    skippedResumed: 0,
    skippedUnresolved: 0,
  };

  type RegistryUpsert = Parameters<typeof IsrcRegistryModel.bulkWrite>[0][number];
  let batch: RegistryUpsert[] = [];

  const flush = async (rowsCoveredByBatch: number): Promise<void> => {
    if (batch.length > 0) {
      await IsrcRegistryModel.bulkWrite(batch, { ordered: false });
      summary.documentsWritten += batch.length;
      batch = [];
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

    batch.push({
      updateOne: {
        filter: { isrc },
        update: {
          $set: {
            recordingMbid: recording.gid,
            title: recording.title,
            artistCredit,
            artistCreditNameKey: normalizeNameKey(artistCredit),
            releaseCount: releaseCounts?.get(recordingId) ?? 0,
            ...(recording.lengthMs !== undefined && { lengthMs: recording.lengthMs }),
          },
        },
        upsert: true,
      },
    });

    if (batch.length >= options.batchSize) {
      await flush(summary.isrcRowsRead);
      logger.info(`isrc: ${summary.documentsWritten} documents written`);
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
  await connectToDatabase();
  try {
    const summary = await importIsrcRegistry(options);
    logger.info(
      `ISRC registry import complete: read ${summary.isrcRowsRead} rows, wrote ${summary.documentsWritten}, ` +
        `resumed past ${summary.skippedResumed}, dropped ${summary.skippedUnresolved} unresolved`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    logger.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
