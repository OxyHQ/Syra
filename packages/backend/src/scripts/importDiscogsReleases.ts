/**
 * Import the Discogs monthly release dump into `DiscogsRelease`.
 *
 * Third slice on the same import pipeline as the two MusicBrainz ones, sharing
 * `dumpImport.ts`'s checkpointing and CLI. What differs is only the format: the
 * Discogs dumps are gzipped XML rather than PostgreSQL COPY text, so this file
 * carries its own reader.
 *
 * WHAT IT ADDS THAT MUSICBRAINZ DOES NOT
 * Per-role CREDITS — the `<extraartists>` block naming the producer, the
 * engineer, the mixer, the person who played the cello — plus label, catalogue
 * number, format, country and release date. That feeds `Track.credits[]`
 * directly, which is the part of a release MusicBrainz is thinnest on.
 *
 * LICENCE, AND THE LINE IT DRAWS
 * The dumps are CC0 with commercial use explicitly permitted. Discogs
 * deliberately EXCLUDES image URLs from them and states that the discographical
 * data is public domain while the images are not. This importer therefore takes
 * data and never images, and there is no code path here that reaches for the
 * authenticated Discogs API to recover an image URL. That distinction is the
 * same line the whole enrichment design follows.
 *
 *   # https://www.discogs.com/data/  (monthly, ~12 GB compressed for releases)
 *   curl -O https://discogs-data-dumps.s3.us-west-2.amazonaws.com/data/<year>/discogs_<date>_releases.xml.gz
 *   bun run src/scripts/importDiscogsReleases.ts --dump-file ./discogs_<date>_releases.xml.gz
 *
 * ── NOT VERIFIED AGAINST A REAL DUMP ────────────────────────────────────────
 * Written against Discogs' documented and long-stable XML schema, NOT against a
 * downloaded dump: the S3 bucket answers 403 from the environment this was built
 * in, so no real file could be fetched to check the parser against. The
 * MusicBrainz importers were verified the other way — a real 80 MB slice of the
 * actual `mbdump.tar.bz2` was downloaded and its tar layout and TSV escaping
 * confirmed by hand — so the difference is worth stating rather than glossing.
 * `importDiscogsReleases.test.ts` exercises this parser against XML in the
 * documented shape, which validates the parser and NOT the assumption that the
 * dump matches the documentation. First real run should be over a single month
 * with `--limit` and the output eyeballed.
 */

import fs from 'fs';
import zlib from 'zlib';
import mongoose from 'mongoose';
import { XMLParser } from 'fast-xml-parser';
import { normalizeNameKey } from '@syra/shared-types';
import type { TrackCredit } from '@syra/shared-types';
import { DiscogsReleaseModel } from '../models/DiscogsRelease';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';
import { loadCheckpoint, parseDumpArgs, writeCheckpoint } from './dumpImport';

// ── Streaming reader ────────────────────────────────────────────────────────

/**
 * Yield one `<release>…</release>` element at a time.
 *
 * The releases dump is ~12 GB compressed and far more expanded, so it cannot be
 * parsed as one document. `fast-xml-parser` has no streaming mode, so the file
 * is scanned for element boundaries and each element is handed to the parser on
 * its own — bounded memory, and the parser still does the actual XML work rather
 * than this reaching for regex to extract fields.
 *
 * Boundary scanning is safe here because `<release ` and `</release>` cannot
 * appear inside character data: the dump escapes `<` as `&lt;` throughout, which
 * is what makes an XML document an XML document.
 */
export async function* readReleaseElements(filePath: string): AsyncGenerator<string> {
  const input = fs.createReadStream(filePath);
  const stream = filePath.endsWith('.gz') ? input.pipe(zlib.createGunzip()) : input;

  let buffer = '';
  const OPEN = '<release ';
  const CLOSE = '</release>';

  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');

    for (;;) {
      const start = buffer.indexOf(OPEN);
      if (start < 0) {
        // Keep only enough of the tail to complete a split opening tag.
        if (buffer.length > OPEN.length) buffer = buffer.slice(-OPEN.length);
        break;
      }
      const end = buffer.indexOf(CLOSE, start);
      if (end < 0) {
        buffer = buffer.slice(start);
        break;
      }
      yield buffer.slice(start, end + CLOSE.length);
      buffer = buffer.slice(end + CLOSE.length);
    }
  }
}

// ── Element → document ──────────────────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface ParsedDiscogsRelease {
  discogsReleaseId: string;
  barcodes: string[];
  title: string;
  artistNames: string[];
  labels: string[];
  catalogNumbers: string[];
  formats: string[];
  countryCode?: string;
  released?: string;
  credits: TrackCredit[];
}

/**
 * Read one release element.
 *
 * Returns `undefined` for a release with no id, no title, or no barcode.
 * The barcode is not optional decoration — it is the ONLY strong key that joins
 * a Discogs release to a file somebody uploaded, because `BARCODE`/`UPC` is what
 * the tags carry. A release we cannot join to anything is a row that will never
 * be read.
 */
export function parseReleaseElement(xml: string): ParsedDiscogsRelease | undefined {
  const parsed = record(record(parser.parse(xml))?.release);
  if (!parsed) return undefined;

  const discogsReleaseId = text(parsed['@id']);
  const title = text(parsed.title);
  if (!discogsReleaseId || !title) return undefined;

  const barcodes = asList(record(parsed.identifiers)?.identifier)
    .map((identifier) => record(identifier))
    .filter((identifier) => text(identifier?.['@type'])?.toLowerCase() === 'barcode')
    // Discogs writes barcodes as printed, spaces and all; the tag side is
    // digits, so they are normalised to digits to make the join possible at all.
    .map((identifier) => text(identifier?.['@value'])?.replace(/\D/g, ''))
    .filter((barcode): barcode is string => barcode !== undefined && barcode.length > 0);
  if (barcodes.length === 0) return undefined;

  const artistNames = asList(record(parsed.artists)?.artist)
    .map((artist) => text(record(artist)?.name))
    .filter((name): name is string => name !== undefined);

  const labelElements = asList(record(parsed.labels)?.label).map((label) => record(label));
  const labels = labelElements
    .map((label) => text(label?.['@name']))
    .filter((name): name is string => name !== undefined);
  const catalogNumbers = labelElements
    .map((label) => text(label?.['@catno']))
    .filter((catno): catno is string => catno !== undefined && catno.toLowerCase() !== 'none');

  const formats = asList(record(parsed.formats)?.format)
    .map((format) => text(record(format)?.['@name']))
    .filter((name): name is string => name !== undefined);

  // `<extraartists>` is the per-role credit list — the reason this source is
  // here. One entry per role, because Discogs writes `Producer, Mixed By` as a
  // single comma-separated string and each is a separate credit.
  const credits: TrackCredit[] = [];
  for (const raw of asList(record(parsed.extraartists)?.artist)) {
    const artist = record(raw);
    const name = text(artist?.name);
    const roles = text(artist?.role);
    if (!name || !roles) continue;
    for (const role of roles.split(',').map((value) => value.trim()).filter(Boolean)) {
      credits.push({ name, role, nameKey: normalizeNameKey(name) });
    }
  }

  return {
    discogsReleaseId,
    barcodes: [...new Set(barcodes)],
    title,
    artistNames,
    labels: [...new Set(labels)],
    catalogNumbers: [...new Set(catalogNumbers)],
    formats: [...new Set(formats)],
    ...(text(parsed.country) !== undefined && { countryCode: text(parsed.country) }),
    ...(text(parsed.released) !== undefined && { released: text(parsed.released) }),
    credits,
  };
}

// ── Import ──────────────────────────────────────────────────────────────────

export interface DiscogsImportOptions {
  dumpFile: string;
  checkpointPath: string;
  batchSize: number;
  /** Stop after this many releases. For a first run over a real dump. */
  limit?: number;
}

export interface DiscogsImportSummary {
  releasesRead: number;
  documentsWritten: number;
  skippedResumed: number;
  skippedUnusable: number;
}

export async function importDiscogsReleases(
  options: DiscogsImportOptions,
): Promise<DiscogsImportSummary> {
  // The dump file names itself (`discogs_20260701_releases.xml.gz`), so its own
  // name is its identity — the same role `TIMESTAMP` plays for MusicBrainz.
  const dumpTimestamp = options.dumpFile.split('/').pop() ?? options.dumpFile;
  const alreadyCommitted = loadCheckpoint(options.checkpointPath, dumpTimestamp);
  if (alreadyCommitted > 0) {
    logger.info(`resuming ${dumpTimestamp} after ${alreadyCommitted} committed releases`);
  }

  const summary: DiscogsImportSummary = {
    releasesRead: 0,
    documentsWritten: 0,
    skippedResumed: 0,
    skippedUnusable: 0,
  };

  type ReleaseUpsert = Parameters<typeof DiscogsReleaseModel.bulkWrite>[0][number];
  let batch: ReleaseUpsert[] = [];

  const flush = async (rowsCovered: number): Promise<void> => {
    if (batch.length > 0) {
      await DiscogsReleaseModel.bulkWrite(batch, { ordered: false });
      summary.documentsWritten += batch.length;
      batch = [];
    }
    writeCheckpoint(options.checkpointPath, { dumpTimestamp, committedRows: rowsCovered });
  };

  for await (const element of readReleaseElements(options.dumpFile)) {
    summary.releasesRead += 1;
    if (summary.releasesRead <= alreadyCommitted) {
      summary.skippedResumed += 1;
      continue;
    }
    if (options.limit !== undefined && summary.releasesRead > options.limit) break;

    const release = parseReleaseElement(element);
    if (!release) {
      summary.skippedUnusable += 1;
      continue;
    }

    const { discogsReleaseId, ...fields } = release;
    batch.push({
      updateOne: { filter: { discogsReleaseId }, update: { $set: fields }, upsert: true },
    });

    if (batch.length >= options.batchSize) {
      await flush(summary.releasesRead);
      logger.info(`discogs: ${summary.documentsWritten} releases written`);
    }
  }

  await flush(summary.releasesRead);
  return summary;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // `parseDumpArgs` wants a directory; this dump is a single file, so the shared
  // parser handles the checkpoint and batch size and the file path is read here.
  const argv = process.argv.slice(2);
  const dumpFileIndex = argv.indexOf('--dump-file');
  const dumpFile = dumpFileIndex >= 0 ? argv[dumpFileIndex + 1] : undefined;
  if (!dumpFile) {
    throw new Error(
      'Usage: bun run src/scripts/importDiscogsReleases.ts --dump-file <discogs_<date>_releases.xml.gz> ' +
        '[--checkpoint <file>] [--batch-size <n>] [--limit <n>]',
    );
  }

  const shared = parseDumpArgs(['--dump-dir', '.', ...argv], {
    script: 'importDiscogsReleases',
    defaultCheckpoint: '.discogs-import-checkpoint.json',
  });
  const limitIndex = argv.indexOf('--limit');
  const limitRaw = limitIndex >= 0 ? argv[limitIndex + 1] : undefined;
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive integer, got ${limitRaw}`);
  }

  await connectToDatabase();
  try {
    const summary = await importDiscogsReleases({
      dumpFile,
      checkpointPath: shared.checkpointPath,
      batchSize: shared.batchSize,
      ...(limit !== undefined && { limit }),
    });
    logger.info(
      `Discogs import complete: read ${summary.releasesRead}, wrote ${summary.documentsWritten}, ` +
        `resumed past ${summary.skippedResumed}, dropped ${summary.skippedUnusable} without a barcode`,
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
