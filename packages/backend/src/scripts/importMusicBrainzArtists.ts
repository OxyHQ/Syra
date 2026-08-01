/**
 * Import the ARTIST slice of the MusicBrainz database into `MusicBrainzArtist`.
 *
 * The sibling of `importIsrcRegistry.ts`, reading the same extracted dump with
 * the same COPY-format parser, the same checkpoint discipline and the same
 * idempotent upsert. One import pipeline, two slices — not two bespoke ones.
 *
 * WHY A LOCAL SLICE AND NOT THE WEB SERVICE
 * MetaBrainz charges for commercial use of the MusicBrainz web service. The
 * sanctioned free route is the CC0 data dump, which we already download for the
 * ISRC slice. Wikidata and Commons ARE queried live, because their terms carry
 * no such restriction — that asymmetry is deliberate and is why enrichment reads
 * artist identity from here and the photograph from there.
 *
 * WHAT IT FEEDS
 * `enrichCatalogEntity.ts`, keyed by the artist MBID a Picard-tagged file
 * carries as `MUSICBRAINZ_ARTISTID`. It supplies sort name, disambiguation,
 * type, country, begin/end dates, aliases, ISNI/IPI and the URL relationships —
 * including the artist's official homepage.
 *
 *   LATEST=$(curl -s https://data.metabrainz.org/pub/musicbrainz/data/fullexport/LATEST)
 *   curl -O "https://data.metabrainz.org/pub/musicbrainz/data/fullexport/$LATEST/mbdump.tar.bz2"
 *   tar -xjf mbdump.tar.bz2
 *   bun run src/scripts/importMusicBrainzArtists.ts --dump-dir ./mbdump
 *
 * Monthly, alongside the ISRC slice — the two read the same extracted directory,
 * so one download serves both.
 */

import mongoose from 'mongoose';
import { normalizeNameKey } from '@syra/shared-types';
import type { ArtistType } from '@syra/shared-types';
import { MusicBrainzArtistModel } from '../models/MusicBrainzArtist';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';
import {
  loadCheckpoint,
  parseDumpArgs,
  readDumpTable,
  readDumpTimestamp,
  unescapeCopyValue,
  writeCheckpoint,
  type DumpImportOptions,
} from './dumpImport';

// ── Dump column layout (admin/sql/CreateTables.sql) ─────────────────────────

/** `artist`: id, gid, name, sort_name, begin_date_year, begin_date_month, begin_date_day, end_date_year, end_date_month, end_date_day, type, area, gender, comment, edits_pending, last_updated, ended, begin_area, end_area */
const ARTIST_COLUMNS = {
  id: 0,
  gid: 1,
  name: 2,
  sortName: 3,
  beginYear: 4,
  beginMonth: 5,
  beginDay: 6,
  endYear: 7,
  endMonth: 8,
  endDay: 9,
  type: 10,
  area: 11,
  comment: 13,
  ended: 16,
} as const;

/** `artist_type`: id, name, parent, child_order, description, gid */
const ARTIST_TYPE_COLUMNS = { id: 0, name: 1 } as const;

/** `area`: id, gid, name, type, edits_pending, last_updated, begin_date_year, … */
const AREA_COLUMNS = { id: 0, name: 2 } as const;

/** `iso_3166_1`: area, code */
const ISO_3166_1_COLUMNS = { area: 0, code: 1 } as const;

/** `artist_alias`: id, artist, name, locale, edits_pending, last_updated, type, sort_name, … */
const ARTIST_ALIAS_COLUMNS = { artist: 1, name: 2 } as const;

/** `artist_isni`: artist, isni, edits_pending, created */
const ARTIST_ISNI_COLUMNS = { artist: 0, isni: 1 } as const;

/** `artist_ipi`: artist, ipi, edits_pending, created */
const ARTIST_IPI_COLUMNS = { artist: 0, ipi: 1 } as const;

/** `url`: id, gid, url, edits_pending, last_updated */
const URL_COLUMNS = { id: 0, url: 2 } as const;

/** `l_artist_url`: id, link, entity0 (artist), entity1 (url), edits_pending, last_updated, link_order, entity0_credit, entity1_credit */
const L_ARTIST_URL_COLUMNS = { link: 1, artist: 2, url: 3 } as const;

/** `link`: id, link_type, begin_date_year, …, attribute_count, created, ended */
const LINK_COLUMNS = { id: 0, linkType: 1 } as const;

/** `link_type`: id, parent, child_order, gid, entity_type0, entity_type1, name, description, … */
const LINK_TYPE_COLUMNS = { id: 0, name: 6 } as const;

/**
 * MusicBrainz artist types, by their `artist_type.id`.
 *
 * Read from the dump rather than hard-coded, so a new type added upstream does
 * not silently import as the wrong one. The mapping below only translates
 * MusicBrainz's names into our own enum.
 */
const ARTIST_TYPE_NAMES: Readonly<Record<string, ArtistType>> = {
  Person: 'person',
  Group: 'group',
  Orchestra: 'orchestra',
  Choir: 'choir',
  Character: 'character',
  Other: 'other',
};

/**
 * Assemble a partial ISO date from the dump's separate year/month/day columns.
 *
 * MusicBrainz stores each component separately and leaves the ones it does not
 * know NULL — an artist known to have formed in 1960 has a year and nothing
 * else. The result keeps that precision (`1960`, not `1960-01-01`), because
 * inventing a day is inventing a fact.
 */
function partialDate(columns: string[], year: number, month: number, day: number): string | undefined {
  const yearValue = unescapeCopyValue(columns[year]);
  if (!yearValue) return undefined;
  const monthValue = unescapeCopyValue(columns[month]);
  if (!monthValue) return yearValue;
  const dayValue = unescapeCopyValue(columns[day]);
  const padded = monthValue.padStart(2, '0');
  return dayValue ? `${yearValue}-${padded}-${dayValue.padStart(2, '0')}` : `${yearValue}-${padded}`;
}

// ── Passes ──────────────────────────────────────────────────────────────────

async function readLookupTable(
  dumpDir: string,
  table: string,
  columns: { id: number; name: number },
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for await (const row of readDumpTable(dumpDir, table)) {
    const id = unescapeCopyValue(row[columns.id]);
    const name = unescapeCopyValue(row[columns.name]);
    if (id && name) map.set(id, name);
  }
  return map;
}

/** Area id → ISO country code, for the artist's country. */
async function readCountryCodes(dumpDir: string): Promise<Map<string, string>> {
  const codes = new Map<string, string>();
  for await (const row of readDumpTable(dumpDir, 'iso_3166_1')) {
    const area = unescapeCopyValue(row[ISO_3166_1_COLUMNS.area]);
    const code = unescapeCopyValue(row[ISO_3166_1_COLUMNS.code]);
    if (area && code && !codes.has(area)) codes.set(area, code);
  }
  return codes;
}

async function readAliases(dumpDir: string): Promise<Map<string, string[]>> {
  const aliases = new Map<string, string[]>();
  for await (const row of readDumpTable(dumpDir, 'artist_alias')) {
    const artist = unescapeCopyValue(row[ARTIST_ALIAS_COLUMNS.artist]);
    const name = unescapeCopyValue(row[ARTIST_ALIAS_COLUMNS.name]);
    if (!artist || !name) continue;
    const existing = aliases.get(artist);
    if (existing) {
      if (!existing.includes(name)) existing.push(name);
    } else {
      aliases.set(artist, [name]);
    }
  }
  return aliases;
}

async function readSingleValue(
  dumpDir: string,
  table: string,
  columns: { artist: number; value: number },
): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  for await (const row of readDumpTable(dumpDir, table)) {
    const artist = unescapeCopyValue(row[columns.artist]);
    const value = unescapeCopyValue(row[columns.value]);
    if (artist && value && !values.has(artist)) values.set(artist, value);
  }
  return values;
}

/**
 * Artist → the URL relationships MusicBrainz records for them.
 *
 * A four-table join (`l_artist_url` → `link` → `link_type`, plus `url`), because
 * the relationship TYPE is what makes a URL useful: "official homepage" belongs
 * on the profile, "discography page" does not, and the raw URL alone cannot tell
 * you which is which.
 */
async function readArtistUrls(
  dumpDir: string,
): Promise<Map<string, Array<{ type: string; url: string }>>> {
  const linkTypeNames = await readLookupTable(dumpDir, 'link_type', LINK_TYPE_COLUMNS);

  const linkToType = new Map<string, string>();
  for await (const row of readDumpTable(dumpDir, 'link')) {
    const id = unescapeCopyValue(row[LINK_COLUMNS.id]);
    const typeId = unescapeCopyValue(row[LINK_COLUMNS.linkType]);
    const name = typeId === undefined ? undefined : linkTypeNames.get(typeId);
    if (id && name) linkToType.set(id, name);
  }

  const urlById = new Map<string, string>();
  for await (const row of readDumpTable(dumpDir, 'url')) {
    const id = unescapeCopyValue(row[URL_COLUMNS.id]);
    const url = unescapeCopyValue(row[URL_COLUMNS.url]);
    if (id && url) urlById.set(id, url);
  }

  const byArtist = new Map<string, Array<{ type: string; url: string }>>();
  for await (const row of readDumpTable(dumpDir, 'l_artist_url')) {
    const artist = unescapeCopyValue(row[L_ARTIST_URL_COLUMNS.artist]);
    const linkId = unescapeCopyValue(row[L_ARTIST_URL_COLUMNS.link]);
    const urlId = unescapeCopyValue(row[L_ARTIST_URL_COLUMNS.url]);
    if (!artist || !linkId || !urlId) continue;

    const type = linkToType.get(linkId);
    const url = urlById.get(urlId);
    if (!type || !url) continue;

    const existing = byArtist.get(artist);
    if (existing) existing.push({ type, url });
    else byArtist.set(artist, [{ type, url }]);
  }
  return byArtist;
}

// ── Import ──────────────────────────────────────────────────────────────────

export interface MusicBrainzArtistImportSummary {
  artistRowsRead: number;
  documentsWritten: number;
  skippedResumed: number;
  skippedUnusable: number;
}

export async function importMusicBrainzArtists(
  options: DumpImportOptions,
): Promise<MusicBrainzArtistImportSummary> {
  const dumpTimestamp = readDumpTimestamp(options.dumpDir);
  const alreadyCommitted = loadCheckpoint(options.checkpointPath, dumpTimestamp);
  if (alreadyCommitted > 0) {
    logger.info(`resuming dump ${dumpTimestamp} after ${alreadyCommitted} committed artist rows`);
  }

  const [typeNames, areaNames, countryCodes, aliases, isni, ipi, urls] = [
    await readLookupTable(options.dumpDir, 'artist_type', ARTIST_TYPE_COLUMNS),
    await readLookupTable(options.dumpDir, 'area', AREA_COLUMNS),
    await readCountryCodes(options.dumpDir),
    await readAliases(options.dumpDir),
    await readSingleValue(options.dumpDir, 'artist_isni', {
      artist: ARTIST_ISNI_COLUMNS.artist,
      value: ARTIST_ISNI_COLUMNS.isni,
    }),
    await readSingleValue(options.dumpDir, 'artist_ipi', {
      artist: ARTIST_IPI_COLUMNS.artist,
      value: ARTIST_IPI_COLUMNS.ipi,
    }),
    await readArtistUrls(options.dumpDir),
  ];

  const summary: MusicBrainzArtistImportSummary = {
    artistRowsRead: 0,
    documentsWritten: 0,
    skippedResumed: 0,
    skippedUnusable: 0,
  };

  type ArtistUpsert = Parameters<typeof MusicBrainzArtistModel.bulkWrite>[0][number];
  let batch: ArtistUpsert[] = [];

  const flush = async (rowsCovered: number): Promise<void> => {
    if (batch.length > 0) {
      await MusicBrainzArtistModel.bulkWrite(batch, { ordered: false });
      summary.documentsWritten += batch.length;
      batch = [];
    }
    writeCheckpoint(options.checkpointPath, { dumpTimestamp, committedRows: rowsCovered });
  };

  for await (const row of readDumpTable(options.dumpDir, 'artist')) {
    summary.artistRowsRead += 1;
    if (summary.artistRowsRead <= alreadyCommitted) {
      summary.skippedResumed += 1;
      continue;
    }

    const id = unescapeCopyValue(row[ARTIST_COLUMNS.id]);
    const mbid = unescapeCopyValue(row[ARTIST_COLUMNS.gid]);
    const name = unescapeCopyValue(row[ARTIST_COLUMNS.name]);
    const sortName = unescapeCopyValue(row[ARTIST_COLUMNS.sortName]);
    if (!id || !mbid || !name || !sortName) {
      summary.skippedUnusable += 1;
      continue;
    }

    const areaId = unescapeCopyValue(row[ARTIST_COLUMNS.area]);
    const typeId = unescapeCopyValue(row[ARTIST_COLUMNS.type]);
    const typeName = typeId === undefined ? undefined : typeNames.get(typeId);
    const artistType = typeName === undefined ? undefined : ARTIST_TYPE_NAMES[typeName];

    const beginDate = partialDate(
      row,
      ARTIST_COLUMNS.beginYear,
      ARTIST_COLUMNS.beginMonth,
      ARTIST_COLUMNS.beginDay,
    );
    const endDate = partialDate(
      row,
      ARTIST_COLUMNS.endYear,
      ARTIST_COLUMNS.endMonth,
      ARTIST_COLUMNS.endDay,
    );

    batch.push({
      updateOne: {
        filter: { mbid },
        update: {
          $set: {
            name,
            sortName,
            nameKey: normalizeNameKey(name),
            ended: unescapeCopyValue(row[ARTIST_COLUMNS.ended]) === 't',
            aliases: aliases.get(id) ?? [],
            urls: urls.get(id) ?? [],
            ...(unescapeCopyValue(row[ARTIST_COLUMNS.comment]) !== undefined && {
              disambiguation: unescapeCopyValue(row[ARTIST_COLUMNS.comment]),
            }),
            ...(artistType !== undefined && { artistType }),
            ...(areaId !== undefined && areaNames.has(areaId) && { areaName: areaNames.get(areaId) }),
            ...(areaId !== undefined && countryCodes.has(areaId) && {
              countryCode: countryCodes.get(areaId),
            }),
            ...(beginDate !== undefined && { beginDate }),
            ...(endDate !== undefined && { endDate }),
            ...(isni.has(id) && { isni: isni.get(id) }),
            ...(ipi.has(id) && { ipi: ipi.get(id) }),
          },
        },
        upsert: true,
      },
    });

    if (batch.length >= options.batchSize) {
      await flush(summary.artistRowsRead);
      logger.info(`artist: ${summary.documentsWritten} documents written`);
    }
  }

  await flush(summary.artistRowsRead);
  return summary;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseDumpArgs(process.argv.slice(2), {
    script: 'importMusicBrainzArtists',
    defaultCheckpoint: '.musicbrainz-artist-import-checkpoint.json',
  });
  await connectToDatabase();
  try {
    const summary = await importMusicBrainzArtists(options);
    logger.info(
      `MusicBrainz artist import complete: read ${summary.artistRowsRead}, wrote ${summary.documentsWritten}, ` +
        `resumed past ${summary.skippedResumed}, dropped ${summary.skippedUnusable} unusable`,
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
