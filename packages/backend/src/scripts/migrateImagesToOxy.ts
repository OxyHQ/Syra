/**
 * One-shot: copy every image still in Syra's legacy bucket into Oxy Files
 * (OxyHQ/oxy ADR 0043), and point its row at the copy.
 *
 * ## What moves, and to whom
 *
 * - A catalogue image SET (the six size rows `createImageSizes` used to write,
 *   one source, one `catalog_source_content_hash`) becomes ONE file the Syra
 *   application owns: only the ORIGINAL is copied, and every row of the set —
 *   and of every duplicate set of the same bytes — names that file and the Oxy
 *   rendition for its size. Six objects become one file. Sets are IMPORTED, 50
 *   to an `importAppFiles` call, from Syra's own `GET /api/images/:id` (which
 *   streams the bucket object for a row with no file yet): Oxy meters an
 *   application's uploads and imports together, per CALL, so one batch of 50
 *   costs what one upload does. Uploading the ~83 000 sets one by one at the
 *   budget a migration may use would take three days; importing them, hours.
 * - A person's upload (`uploaded_by` set) becomes a file in THEIR Oxy account.
 *   An uploader Oxy no longer knows (a deleted account) cannot own anything, so
 *   that image becomes Syra's, and the report says so.
 * - Any other single image becomes Syra's.
 * - A house's avatar and cover, a room's stream image and a series' cover
 *   become files of the space's owner (`services/oxyFiles/spaceImages.ts`).
 *
 * NOT moved, and reported instead:
 *
 * - an image nothing references (`unreferenced`): copying garbage would make
 *   Oxy store it; the retirement step deletes it with the bucket;
 * - an Alia show's cover (`alia_handover`): it belongs to Alia, which copies it
 *   into its own files; `migrateAliaCovers.ts` then points the show at that;
 * - an object missing from the bucket (`missing_object`): there is nothing to
 *   copy. `--apply` marks the row `missing` so nothing serves it again.
 *
 * ## Verified, resumable, and safe to re-run
 *
 * Every upload is hashed first and compared with the SHA-256 Oxy answers; an
 * imported set's original must hash, as Oxy stored it, to the content hash
 * recorded when it was mirrored. A mismatch repoints nothing (the file Oxy made
 * is unreferenced, so Oxy collects it). A row is "done" exactly when it names an
 * Oxy file, so a re-run — after an interruption, a failure, or a bounded
 * `--limit` pass — continues with what is left, and Oxy's per-owner
 * deduplication makes a repeated upload of the same bytes answer the same file.
 * Pointing a row at its file is what queues Syra's reference to it (migration
 * `0034`'s triggers), so a copied application file is in use from the start.
 *
 * Every Oxy write goes through {@link OxyWritePacer}: a third of Oxy's
 * per-application budget is left to Syra's live catalogue imports, and a 429 is
 * waited out and the same call made again — a run is never "restarted" by one.
 *
 * Reports carry SHA-256 hashes and Syra's own row ids — never a URL or a bucket
 * key. One JSON line per unit through the logger (`[migrate-images-to-oxy]`).
 *
 * ## Running it
 *
 *   bun run migrate:images-to-oxy                        # preview (the default)
 *   bun run migrate:images-to-oxy -- --apply             # copy and repoint
 *   bun run migrate:images-to-oxy -- --apply --limit 200 # a bounded pass (units)
 *   bun run migrate:images-to-oxy -- --apply --concurrency 8
 *
 * In production, through `.github/workflows/run-backend-script.yml`
 * (`migrate-images-to-oxy`). `docs/runbooks/oxy-files-images.md` is the order.
 */

import sharp from 'sharp';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxy.so/db';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { env } from '../config/env';
import { imageAssets } from '../db/schema/catalog';
import { podcastSources } from '../db/schema/podcasts';
import { houses, rooms, series } from '../db/schema/rooms';
import type { LegacyImageReadKind } from '../db/schema/oxyFiles';
import {
  CATALOG_IMAGE_SIZES,
  CATALOG_SIZE_VARIANTS,
  uploadAppImage,
  uploadUserImage,
  variantDimensions,
  type StoredOxyFile,
} from '../services/oxyFiles/images';
import {
  LegacyObjectTooLargeError,
  legacyObjectExists,
  readLegacyObject,
  sha256Hex,
  type LegacyObjectReader,
} from '../services/oxyFiles/legacyObjects';
import { oxyFiles } from '../services/oxyFiles/client';
import { OxyWritePacer } from '../services/oxyFiles/writePacer';
import { cdnUrlToKey } from '../utils/spaces';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

const BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;
/** Sets per `importAppFiles` call: Oxy's batch ceiling. */
const IMPORT_BATCH_SIZE = 50;

export type MigrationOutcome =
  | 'planned'
  | 'copied'
  | 'unreferenced'
  | 'alia_handover'
  | 'missing_object'
  | 'hash_mismatch'
  | 'unsupported_type'
  | 'too_large'
  | 'failed';

export interface MigrationReportLine {
  kind: 'catalog_set' | 'image' | Exclude<LegacyImageReadKind, 'image_asset'>;
  /** Syra row ids the unit covers. */
  ids: string[];
  owner?: 'application' | 'account';
  /** True when the uploader is gone and Syra took the image over. */
  ownerFallback?: boolean;
  sha256?: string;
  fileId?: string;
  bytes?: number;
  outcome: MigrationOutcome;
  reason?: string;
}

export interface ImageMigrationOptions {
  apply?: boolean;
  /** Bounds the number of UNITS (a set, an image, a space image) handled. */
  limit?: number;
  concurrency?: number;
  /** Which half to run; both by default. */
  only?: 'images' | 'spaces';
  readObject?: LegacyObjectReader;
  /** Whether the bucket still holds `key` — asked only after an import failed. */
  objectExists?: (key: string) => Promise<boolean>;
  /**
   * The https origin Oxy imports a set's original from (`<origin>/api/images/:id`).
   * Defaults to `STREAM_KEY_BASE_URL`, the API's public origin.
   */
  publicOrigin?: string;
  pacer?: OxyWritePacer;
  report?: (line: MigrationReportLine) => void;
}

export type ImageMigrationStats = Record<MigrationOutcome, number> & { units: number };

function emptyStats(): ImageMigrationStats {
  return {
    units: 0,
    planned: 0,
    copied: 0,
    unreferenced: 0,
    alia_handover: 0,
    missing_object: 0,
    hash_mismatch: 0,
    unsupported_type: 0,
    too_large: 0,
    failed: 0,
  };
}

/** The MIME type Oxy is told: the stored one when it is an image, the sniffed format otherwise. */
async function imageMime(bytes: Buffer, stored: string | undefined): Promise<string | null> {
  if (stored?.startsWith('image/') && !stored.startsWith('image/svg')) return stored;
  try {
    const { format } = await sharp(bytes).metadata();
    if (!format || format === 'svg') return null;
    return `image/${format}`;
  } catch {
    return null;
  }
}

/** Upload to the person's account; a person Oxy no longer knows cannot own it, so Syra does. */
async function uploadOwned(
  pacer: OxyWritePacer,
  ownerOxyUserId: string | null,
  bytes: Buffer,
  mime: string,
  name: string,
): Promise<{ file: StoredOxyFile; owner: 'application' | 'account'; ownerFallback: boolean }> {
  const asApplication = () => pacer.call('app', () => uploadAppImage(bytes, mime, name));
  if (ownerOxyUserId === null) {
    return { file: await asApplication(), owner: 'application', ownerFallback: false };
  }
  try {
    return {
      file: await pacer.call('user_media', () =>
        uploadUserImage(ownerOxyUserId, bytes, mime, name),
      ),
      owner: 'account',
      ownerFallback: false,
    };
  } catch (error) {
    if ((error as { status?: number }).status !== 403) throw error;
    return { file: await asApplication(), owner: 'application', ownerFallback: true };
  }
}

/** Copy bytes and prove Oxy stored exactly them. */
function verified(file: StoredOxyFile, expectedSha: string): StoredOxyFile {
  if (file.sha256 !== expectedSha) {
    throw new Error(`Oxy stored ${file.sha256} for bytes hashing ${expectedSha}`);
  }
  return file;
}

// ── image_assets ─────────────────────────────────────────────────────────

interface LegacyRow {
  id: string;
  s3Key: string;
  contentType: string;
  uploadedBy: string | null;
  contentHash: string | null;
  size: string | null;
  width: number | null;
  height: number | null;
  users: Array<{ t: string; id: string }>;
}

/** The next legacy rows after `after`, each with every entity that names it. */
async function nextLegacyRows(after: string | undefined): Promise<LegacyRow[]> {
  const rows = await getDb().execute<{
    id: string;
    s3_key: string;
    content_type: string;
    uploaded_by: string | null;
    content_hash: string | null;
    size: string | null;
    width: number | null;
    height: number | null;
    users: Array<{ t: string; id: string }>;
  }>(sql`
    select ia.id, ia.s3_key, ia.content_type, ia.uploaded_by,
      ia.catalog_source_content_hash as content_hash, ia.catalog_size as size, ia.width, ia.height,
      (select coalesce(json_agg(json_build_object('t', u.entity_type, 'id', u.entity_id)), '[]'::json)
       from oxy_image_asset_users(array[ia.id]) u) as users
    from image_assets ia
    where ia.oxy_file_id is null and ia.s3_key is not null and ia.serving_status = 'active'
      ${after === undefined ? sql`` : sql`and ia.id > ${after}`}
    order by ia.id
    limit ${BATCH_SIZE}
  `);
  return [...rows].map((row) => ({
    id: row.id,
    s3Key: row.s3_key,
    contentType: row.content_type,
    uploadedBy: row.uploaded_by,
    contentHash: row.content_hash,
    size: row.size,
    width: row.width,
    height: row.height,
    users: row.users,
  }));
}

/** Which of these podcasts Alia generated (`podcast_sources.provider = 'alia'`). */
async function aliaPodcasts(podcastIds: string[]): Promise<Set<string>> {
  if (podcastIds.length === 0) return new Set();
  const rows = await getDb()
    .select({ podcastId: podcastSources.podcastId })
    .from(podcastSources)
    .where(and(eq(podcastSources.provider, 'alia'), inArray(podcastSources.podcastId, podcastIds)));
  return new Set(rows.map((row) => row.podcastId));
}

/** The original row of a catalogue set, when the set has one in the bucket. */
async function setOriginal(contentHash: string) {
  const [row] = await getDb()
    .select({
      id: imageAssets.id,
      s3Key: imageAssets.s3Key,
      contentType: imageAssets.contentType,
      width: imageAssets.width,
      height: imageAssets.height,
    })
    .from(imageAssets)
    .where(
      and(
        eq(imageAssets.catalogSourceContentHash, contentHash),
        eq(imageAssets.catalogSize, 'original'),
        isNotNull(imageAssets.s3Key),
        // What `GET /api/images/:id` still streams from the bucket.
        isNull(imageAssets.oxyFileId),
        eq(imageAssets.servingStatus, 'active'),
      ),
    )
    .orderBy(asc(imageAssets.createdAt))
    .limit(1);
  return row;
}

async function markMissing(ids: string[]): Promise<void> {
  await getDb()
    .update(imageAssets)
    .set({ servingStatus: 'missing', updatedAt: sql`date_trunc('milliseconds', now())` })
    .where(and(inArray(imageAssets.id, ids), isNull(imageAssets.oxyFileId)));
}

type SetRow = LegacyRow & { contentHash: string };

/** Point every legacy row of the set (and of its duplicates) at `fileId`, one rendition per size. */
async function repointSet(
  contentHash: string,
  fileId: string,
  original: { width: number | null; height: number | null },
): Promise<void> {
  const width = original.width ?? 0;
  const height = original.height ?? 0;
  await getDb().transaction(async (tx) => {
    for (const size of CATALOG_IMAGE_SIZES) {
      const variant = CATALOG_SIZE_VARIANTS[size];
      const dims = variantDimensions(width, height, variant);
      await tx
        .update(imageAssets)
        .set({
          oxyFileId: fileId,
          oxyVariant: variant,
          ...(width > 0 && height > 0 ? { width: dims.width, height: dims.height } : {}),
          updatedAt: sql`date_trunc('milliseconds', now())`,
        })
        .where(
          and(
            eq(imageAssets.catalogSourceContentHash, contentHash),
            eq(imageAssets.catalogSize, size),
            isNull(imageAssets.oxyFileId),
          ),
        );
    }
  });
}

/** What an Oxy refusal of a set's import is reported as. */
function refusedOutcome(status: number): MigrationOutcome {
  if (status === 415) return 'unsupported_type';
  if (status === 413) return 'too_large';
  return 'failed';
}

/**
 * Copy up to {@link IMPORT_BATCH_SIZE} catalogue sets with ONE import call.
 *
 * Oxy fetches each set's original from Syra's `GET /api/images/:id`, which
 * streams the bucket object for a row that names no file yet — the exact bytes
 * a direct upload would send, and checked the same way: Oxy's SHA-256 of what it
 * stored must be the content hash recorded when the set was mirrored.
 */
async function migrateSets(
  rows: SetRow[],
  options: ImageMigrationOptions & { pacer: OxyWritePacer; publicOrigin: string },
): Promise<MigrationReportLine[]> {
  const prepared = await Promise.all(
    rows.map(async (row) => {
      const members = await getDb()
        .select({ id: imageAssets.id })
        .from(imageAssets)
        .where(
          and(
            eq(imageAssets.catalogSourceContentHash, row.contentHash),
            isNull(imageAssets.oxyFileId),
            inArray(imageAssets.catalogSize, [...CATALOG_IMAGE_SIZES]),
          ),
        );
      return {
        contentHash: row.contentHash,
        original: await setOriginal(row.contentHash),
        base: {
          kind: 'catalog_set' as const,
          ids: members.map((member) => member.id),
          owner: 'application' as const,
          sha256: row.contentHash,
        },
      };
    }),
  );
  if (!options.apply) return prepared.map(({ base }) => ({ ...base, outcome: 'planned' }));

  const lines: MigrationReportLine[] = [];
  const importable: Array<
    (typeof prepared)[number] & { original: NonNullable<(typeof prepared)[number]['original']> }
  > = [];
  for (const set of prepared) {
    if (set.original?.s3Key) importable.push({ ...set, original: set.original });
    else lines.push({ ...set.base, outcome: 'missing_object', reason: 'the set has no original' });
  }
  if (importable.length === 0) return lines;

  let results: Awaited<ReturnType<ReturnType<typeof oxyFiles>['importAppFiles']>>;
  try {
    results = await options.pacer.call('app', () =>
      oxyFiles().importAppFiles(
        importable.map((set) => ({
          sourceUrl: `${options.publicOrigin}/api/images/${encodeURIComponent(set.original.id)}`,
          visibility: 'public' as const,
        })),
      ),
    );
  } catch (error) {
    const reason = String(describeErrorSafely(error)).slice(0, 300);
    return [
      ...lines,
      ...importable.map((set) => ({ ...set.base, outcome: 'failed' as const, reason })),
    ];
  }

  const exists = options.objectExists ?? legacyObjectExists;
  for (const result of results) {
    const set = importable[result.index];
    if (!set) continue;
    try {
      if (!result.ok) {
        // A source Syra could not serve is, most often, an object the bucket
        // lost: confirm with the bucket itself before saying so.
        if (!(await exists(set.original.s3Key as string))) {
          await markMissing(set.base.ids);
          lines.push({ ...set.base, outcome: 'missing_object' });
          continue;
        }
        lines.push({
          ...set.base,
          outcome: refusedOutcome(result.error.status),
          reason: `${result.error.status} ${result.error.code}`,
        });
        continue;
      }
      if (result.file.sha256 !== set.contentHash) {
        lines.push({
          ...set.base,
          outcome: 'hash_mismatch',
          reason: `Oxy stored ${result.file.sha256}`,
        });
        continue;
      }
      await repointSet(set.contentHash, result.file.id, set.original);
      lines.push({
        ...set.base,
        fileId: result.file.id,
        bytes: result.file.size,
        outcome: 'copied',
      });
    } catch (error) {
      lines.push({
        ...set.base,
        outcome: 'failed',
        reason: String(describeErrorSafely(error)).slice(0, 300),
      });
    }
  }
  // An answer Oxy left out (it never should) is a failure, not a silent skip.
  const answered = new Set(results.map((result) => result.index));
  importable.forEach((set, index) => {
    if (!answered.has(index)) {
      lines.push({ ...set.base, outcome: 'failed', reason: 'no answer for this item' });
    }
  });
  return lines;
}

async function migrateSingle(
  row: LegacyRow,
  options: ImageMigrationOptions & { pacer: OxyWritePacer },
): Promise<MigrationReportLine> {
  const base = {
    kind: 'image' as const,
    ids: [row.id],
    owner: row.uploadedBy === null ? ('application' as const) : ('account' as const),
  };
  if (!options.apply) return { ...base, outcome: 'planned' };

  const read = await (options.readObject ?? readLegacyObject)(row.s3Key);
  if (!read) {
    await markMissing([row.id]);
    return { ...base, outcome: 'missing_object' };
  }
  const digest = sha256Hex(read.bytes);
  const mime = await imageMime(read.bytes, row.contentType);
  if (!mime) return { ...base, sha256: digest, outcome: 'unsupported_type' };

  const uploaded = await uploadOwned(
    options.pacer,
    row.uploadedBy,
    read.bytes,
    mime,
    `image-${row.id}`,
  );
  const file = verified(uploaded.file, digest);
  await getDb()
    .update(imageAssets)
    .set({ oxyFileId: file.id, updatedAt: sql`date_trunc('milliseconds', now())` })
    .where(and(eq(imageAssets.id, row.id), isNull(imageAssets.oxyFileId)));
  return {
    ...base,
    owner: uploaded.owner,
    ...(uploaded.ownerFallback ? { ownerFallback: true } : {}),
    sha256: digest,
    fileId: file.id,
    bytes: file.size,
    outcome: 'copied',
  };
}

// ── house / room / series images ─────────────────────────────────────────

interface SpaceImageSource {
  kind: Exclude<LegacyImageReadKind, 'image_asset'>;
  /** The legacy rows still to copy, after `after`. */
  next(after: string | undefined): Promise<Array<{ id: string; owner: string; url: string }>>;
  /** Point the row at the file, only if it still holds the URL that was copied. */
  repoint(id: string, url: string, fileId: string | null): Promise<void>;
}

/** A space image column pair, named by its drizzle columns so a rename cannot leave this behind. */
function spaceSource(
  kind: SpaceImageSource['kind'],
  table: typeof houses | typeof rooms | typeof series,
  columns: { id: PgColumn; url: PgColumn; file: PgColumn; owner: PgColumn },
): SpaceImageSource {
  const name = (column: PgColumn) => sql.identifier(sqlColumnName(column));
  return {
    kind,
    async next(after) {
      const rows = await getDb().execute<{ id: string; owner: string; url: string }>(sql`
        select ${name(columns.id)} as id, ${name(columns.owner)} as owner, ${name(columns.url)} as url
        from ${table}
        where ${name(columns.url)} is not null and ${name(columns.file)} is null
          ${after === undefined ? sql`` : sql`and ${name(columns.id)} > ${after}`}
        order by ${name(columns.id)}
        limit ${BATCH_SIZE}
      `);
      return [...rows];
    },
    async repoint(rowId, url, fileId) {
      await getDb().execute(sql`
        update ${table}
        set ${name(columns.url)} = null
          ${fileId === null ? sql`` : sql`, ${name(columns.file)} = ${fileId}`}
        where ${name(columns.id)} = ${rowId}
          and ${name(columns.url)} = ${url}
          and ${name(columns.file)} is null
      `);
    },
  };
}

const SPACE_SOURCES: SpaceImageSource[] = [
  spaceSource('house_avatar', houses, {
    id: houses.id,
    url: houses.avatar,
    file: houses.avatarFileId,
    owner: houses.createdBy,
  }),
  spaceSource('house_cover', houses, {
    id: houses.id,
    url: houses.coverImage,
    file: houses.coverImageFileId,
    owner: houses.createdBy,
  }),
  spaceSource('room_stream_image', rooms, {
    id: rooms.id,
    url: rooms.streamImage,
    file: rooms.streamImageFileId,
    owner: rooms.host,
  }),
  spaceSource('series_cover', series, {
    id: series.id,
    url: series.coverImage,
    file: series.coverImageFileId,
    owner: series.createdBy,
  }),
];

async function migrateSpaceImage(
  source: SpaceImageSource,
  row: { id: string; owner: string; url: string },
  options: ImageMigrationOptions & { pacer: OxyWritePacer },
): Promise<MigrationReportLine> {
  const key = cdnUrlToKey(row.url) as string;
  const base = { kind: source.kind, ids: [row.id], owner: 'account' as const };
  if (!options.apply) return { ...base, outcome: 'planned' };

  const read = await (options.readObject ?? readLegacyObject)(key);
  if (!read) {
    // A dead link already; clearing it is what stops it being served — and
    // counted as a legacy read — forever.
    await source.repoint(row.id, row.url, null);
    return { ...base, outcome: 'missing_object' };
  }
  const digest = sha256Hex(read.bytes);
  const mime = await imageMime(read.bytes, read.contentType);
  if (!mime) return { ...base, sha256: digest, outcome: 'unsupported_type' };
  const uploaded = await uploadOwned(
    options.pacer,
    row.owner,
    read.bytes,
    mime,
    `${source.kind}-${row.id}`,
  );
  const file = verified(uploaded.file, digest);
  await source.repoint(row.id, row.url, file.id);
  return {
    ...base,
    owner: uploaded.owner,
    ...(uploaded.ownerFallback ? { ownerFallback: true } : {}),
    sha256: digest,
    fileId: file.id,
    bytes: file.size,
    outcome: 'copied',
  };
}

// ── The run ──────────────────────────────────────────────────────────────

async function pool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    }),
  );
}

export async function migrateImagesToOxy(
  options: ImageMigrationOptions = {},
): Promise<ImageMigrationStats> {
  const stats = emptyStats();
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const publicOrigin = (options.publicOrigin ?? env.STREAM_KEY_BASE_URL).replace(/\/+$/, '');
  if (options.apply && options.only !== 'spaces' && !publicOrigin.startsWith('https://')) {
    // Oxy imports https only, from a public address: a set's original is
    // fetched from the API's own origin, which must therefore be one.
    throw new Error(
      `migrate-images-to-oxy imports catalogue sets from <origin>/api/images/:id, and the origin ` +
        `(STREAM_KEY_BASE_URL) is ${publicOrigin === '' ? 'unset' : `'${publicOrigin}'`}: ` +
        'it must be the https API origin',
    );
  }
  const run = { ...options, pacer: options.pacer ?? new OxyWritePacer(), publicOrigin };
  const report = (line: MigrationReportLine) => {
    stats[line.outcome] += 1;
    options.report?.(line);
  };
  /** Units handed out so far; `--limit` bounds this. */
  let scheduled = 0;
  const take = () => {
    if (options.limit !== undefined && scheduled >= options.limit) return false;
    scheduled += 1;
    return true;
  };

  const budgetLeft = () => options.limit === undefined || scheduled < options.limit;

  /** A unit's failure is reported and the run goes on; a re-run retries it. */
  const guarded = async (
    base: Omit<MigrationReportLine, 'outcome'>,
    run: () => Promise<MigrationReportLine>,
  ) => {
    stats.units += 1;
    try {
      report(await run());
    } catch (error) {
      report({
        ...base,
        outcome: error instanceof LegacyObjectTooLargeError ? 'too_large' : 'failed',
        reason: String(describeErrorSafely(error)).slice(0, 300),
      });
    }
  };

  /** Sets waiting for an import batch. */
  let pendingSets: SetRow[] = [];
  /** Import what is pending in batches of 50, `concurrency` batches at a time. */
  const flushSets = async () => {
    const batches: SetRow[][] = [];
    for (let index = 0; index < pendingSets.length; index += IMPORT_BATCH_SIZE) {
      batches.push(pendingSets.slice(index, index + IMPORT_BATCH_SIZE));
    }
    pendingSets = [];
    await pool(batches, concurrency, async (batch) => {
      stats.units += batch.length;
      for (const line of await migrateSets(batch, run)) report(line);
    });
  };

  if (options.only !== 'spaces') {
    const seenHashes = new Set<string>();
    let after: string | undefined;
    while (budgetLeft()) {
      const rows = await nextLegacyRows(after);
      if (rows.length === 0) break;
      after = rows[rows.length - 1]?.id;

      const alia = await aliaPodcasts(
        rows.flatMap((row) => row.users.filter((u) => u.t === 'podcast').map((u) => u.id)),
      );
      const units: Array<() => Promise<void>> = [];
      for (const row of rows) {
        const contentHash = row.contentHash;
        const isSetMember = contentHash !== null && row.size !== null;
        if (isSetMember && seenHashes.has(contentHash)) continue;
        if (!take()) break;
        if (row.users.length === 0) {
          stats.units += 1;
          report({ kind: 'image', ids: [row.id], outcome: 'unreferenced' });
          continue;
        }
        if (row.users.every((user) => user.t === 'podcast' && alia.has(user.id))) {
          stats.units += 1;
          report({ kind: 'image', ids: [row.id], outcome: 'alia_handover' });
          continue;
        }
        if (isSetMember) {
          seenHashes.add(contentHash);
          pendingSets.push({ ...row, contentHash });
        } else {
          units.push(() =>
            guarded({ kind: 'image', ids: [row.id] }, () => migrateSingle(row, run)),
          );
        }
      }
      await pool(units, concurrency, (unit) => unit());
      if (pendingSets.length >= IMPORT_BATCH_SIZE * concurrency) await flushSets();
    }
    await flushSets();
  }

  if (options.only !== 'images') {
    for (const source of SPACE_SOURCES) {
      let after: string | undefined;
      while (budgetLeft()) {
        const rows = await source.next(after);
        if (rows.length === 0) break;
        after = rows[rows.length - 1]?.id;
        // A URL that never pointed into Syra's bucket (a stream's own thumbnail,
        // a link a client sent) is not Syra's to copy.
        const units = rows.filter((row) => cdnUrlToKey(row.url) !== null).filter(() => take());
        await pool(units, concurrency, (row) =>
          guarded({ kind: source.kind, ids: [row.id] }, () => migrateSpaceImage(source, row, run)),
        );
      }
    }
  }

  return stats;
}

function flagValue(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = Number.parseInt(process.argv[index + 1] ?? '', 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} needs a positive integer`);
  return value;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const only = process.argv.includes('--images-only')
    ? 'images'
    : process.argv.includes('--spaces-only')
      ? 'spaces'
      : undefined;
  await connectPostgres();
  try {
    const stats = await migrateImagesToOxy({
      apply,
      limit: flagValue('--limit'),
      concurrency: flagValue('--concurrency'),
      ...(only ? { only } : {}),
      report: (line) => logger.info('[migrate-images-to-oxy]', { ...line }),
    });
    logger.info(`[migrate-images-to-oxy] ${apply ? 'applied' : 'preview (nothing written)'}`, {
      ...stats,
    });
    if (stats.failed > 0 || stats.hash_mismatch > 0) process.exitCode = 1;
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('[migrate-images-to-oxy] failed', { error: describeErrorSafely(error) });
    process.exit(1);
  });
}
