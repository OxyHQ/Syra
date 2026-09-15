/**
 * One-shot: consolidate DUPLICATE catalog images that were mirrored before
 * `findExistingCatalogImageSet` (`imageAssetService.ts`) existed to prevent
 * exactly this.
 *
 * ## Why this exists
 *
 * Every catalog entity (episode, podcast, track, album, catalog entity,
 * playlist, user upload) that mirrors the SAME source image independently
 * used to get its own full copy: six S3 objects and six `image_assets` rows,
 * every time, even when a hundred episodes in one show's feed pointed at the
 * identical artwork URL. Measured live before this script existed: 193,967
 * of 412,553 rows in `image_assets` (≈47%) belonged to a duplicated group,
 * 22.3 GB of it pure waste.
 *
 * The forward-looking fix stops NEW duplicates. This script cleans up what
 * already exists: for every source-content-hash shared by more than one
 * entity, it keeps the OLDEST complete six-size set as canonical, rewrites
 * every reference to any of the others onto it, and only then deletes the
 * now-unreferenced rows and their S3 objects.
 *
 * ## Every table an image_assets.id can be referenced from
 *
 * `image_assets.id` has 49 foreign-key columns pointing at it, across 7
 * tables (each with one primary id column plus six per-size columns) — this
 * list IS the source of truth for the search, so a table added here later
 * with its own image FK must be added to `REFERENCING_COLUMNS` too, or this
 * script will silently miss its references.
 *
 * ## Safety
 *
 * Per duplicate group, in ONE transaction:
 *   1. Build old-id -> canonical-id for every non-canonical row sharing a
 *      (content hash, size) with a canonical row minted no later.
 *   2. Rewrite every column in `REFERENCING_COLUMNS` from old ids to their
 *      canonical replacement.
 *   3. Verify — a real query, not an assumption — that NOTHING still
 *      references an old id. Any hit aborts the whole transaction rather
 *      than delete a row something still points at.
 *   4. Delete the now-orphaned `image_assets` rows, returning their S3 keys.
 * S3 objects are deleted only AFTER the transaction commits: an S3 delete
 * cannot be rolled back, so it must never run for a transaction that could
 * still abort.
 *
 * Idempotent by construction, the same shape as `backfillEpisodeImages.ts`:
 * the query that finds "still needs consolidating" groups
 * (`having count(distinct catalog_external_id) > 1`) finds nothing once a
 * group has been reduced to its one canonical set, so re-running after an
 * interruption or a partial run only touches what is still duplicated.
 *
 * ## Running it
 *
 *   bun run consolidate:duplicate-images                # against DATABASE_URL
 *   bun run consolidate:duplicate-images -- --dry-run    # report only
 *   bun run consolidate:duplicate-images -- --limit 50   # a bounded first pass (groups)
 */

import { sql } from 'drizzle-orm';
import dotenv from 'dotenv';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { deleteFromS3Batch } from '../services/s3Service';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

dotenv.config();

/** Duplicate content hashes resolved (and, per hash, rewritten) per transaction. */
const HASH_BATCH_SIZE = 200;

/**
 * Every (table, column) that stores an `image_assets.id`. Six of the seven
 * tables share the identical six-size-column shape; only the PRIMARY column
 * name differs (`image_id` vs `cover_art_id`).
 */
const SIZE_COLUMN_SUFFIXES = ['small', 'medium', 'large', 'xlarge', 'xxlarge', 'original'] as const;

interface ReferencingTable {
  table: string;
  primaryColumn: string;
  sizeColumnPrefix: string;
}

const REFERENCING_TABLES: readonly ReferencingTable[] = [
  { table: 'catalog_entities', primaryColumn: 'image_id', sizeColumnPrefix: 'image_sizes' },
  { table: 'albums', primaryColumn: 'cover_art_id', sizeColumnPrefix: 'cover_art_sizes' },
  { table: 'tracks', primaryColumn: 'cover_art_id', sizeColumnPrefix: 'cover_art_sizes' },
  { table: 'user_uploads', primaryColumn: 'cover_art_id', sizeColumnPrefix: 'cover_art_sizes' },
  { table: 'playlists', primaryColumn: 'cover_art_id', sizeColumnPrefix: 'cover_art_sizes' },
  { table: 'podcasts', primaryColumn: 'image_id', sizeColumnPrefix: 'image_sizes' },
  { table: 'episodes', primaryColumn: 'image_id', sizeColumnPrefix: 'image_sizes' },
];

/** Every column name (table, column) pair this script must rewrite. */
function referencingColumns(): Array<{ table: string; column: string }> {
  const pairs: Array<{ table: string; column: string }> = [];
  for (const { table, primaryColumn, sizeColumnPrefix } of REFERENCING_TABLES) {
    pairs.push({ table, column: primaryColumn });
    for (const size of SIZE_COLUMN_SUFFIXES) {
      pairs.push({ table, column: `${sizeColumnPrefix}_${size}_id` });
    }
  }
  return pairs;
}

export interface ConsolidationStats {
  hashGroupsProcessed: number;
  /** A group whose post-rewrite verification found a lingering reference — skipped, not deleted. */
  hashGroupsSkipped: number;
  rowsDeleted: number;
  bytesReclaimed: number;
  s3ObjectsDeleted: number;
}

export interface ConsolidationOptions {
  dryRun?: boolean;
  /** Bounds the number of DUPLICATE HASH GROUPS processed, not rows. */
  limit?: number;
}

/**
 * The next batch of content hashes still shared by more than one entity,
 * ordered and keyset-paginated by the hash itself (`> afterHash`).
 *
 * A plain `LIMIT` with no cursor would re-fetch the SAME batch forever in dry
 * run: nothing gets deleted to remove a hash from the `HAVING` result, so the
 * caller's loop never advances. Paginating by hash guarantees forward
 * progress in both modes regardless of whether the batch's rows were actually
 * consolidated.
 */
async function nextDuplicatedHashes(batchSize: number, afterHash: string | undefined): Promise<string[]> {
  const rows = await getDb().execute<{ hash: string }>(sql`
    select catalog_source_content_hash as hash
    from image_assets
    where catalog_source_content_hash is not null
      ${afterHash !== undefined ? sql`and catalog_source_content_hash > ${afterHash}` : sql``}
    group by catalog_source_content_hash
    having count(distinct catalog_external_id) > 1
    order by catalog_source_content_hash
    limit ${batchSize}
  `);
  return rows.map((row) => row.hash);
}

/**
 * A safely PARAMETERIZED `IN (...)` fragment — never string-concatenated.
 * Hash values are our own sha256 hex digests, so injection is not the
 * realistic threat here, but this is the correct tool regardless of that:
 * `sql.raw` interpolates its argument as literal SQL text, `sql.join` over
 * per-value `sql` templates binds each one as a real query parameter.
 */
function hashInList(hashes: readonly string[]) {
  return sql.join(
    hashes.map((hash) => sql`${hash}`),
    sql`, `
  );
}

async function consolidateBatch(
  hashes: readonly string[],
  stats: ConsolidationStats,
  dryRun: boolean
): Promise<void> {
  const dupMapQuery = sql`
    select dup.id as old_id, canon.id as canonical_id
    from image_assets dup
    join lateral (
      select id from image_assets c
      where c.catalog_source_content_hash = dup.catalog_source_content_hash
        and c.catalog_size = dup.catalog_size
      order by c.created_at asc, c.id asc
      limit 1
    ) canon on true
    where dup.catalog_source_content_hash in (${hashInList(hashes)})
      and dup.id <> canon.id
  `;

  if (dryRun) {
    const preview = await getDb().execute<{ old_id: string }>(dupMapQuery);
    stats.hashGroupsProcessed += hashes.length;
    stats.rowsDeleted += preview.length;
    return;
  }

  const s3KeysToDelete = await getDb().transaction(async (tx) => {
    await tx.execute(sql`create temp table image_asset_dedup_map on commit drop as ${dupMapQuery}`);

    const [{ count: mappedCount }] = await tx.execute<{ count: number }>(
      sql`select count(*)::int as count from image_asset_dedup_map`
    );
    if (mappedCount === 0) return [];

    for (const { table, column } of referencingColumns()) {
      await tx.execute(sql`
        update ${sql.identifier(table)}
        set ${sql.identifier(column)} = m.canonical_id
        from image_asset_dedup_map m
        where ${sql.identifier(table)}.${sql.identifier(column)} = m.old_id
      `);
    }

    // Real verification, not an assumption: every column just rewritten, checked
    // again. A hit here means a table has an image reference this script's
    // REFERENCING_TABLES list does not know about — abort rather than delete a
    // row something still points at.
    const remainingReferenceChecks = referencingColumns().map(
      ({ table, column }) => sql`
        select ${`${table}.${column}`} as location, count(*)::int as remaining
        from ${sql.identifier(table)}
        where ${sql.identifier(column)} in (select old_id from image_asset_dedup_map)
      `
    );
    const remaining = await tx.execute<{ location: string; remaining: number }>(
      sql.join(remainingReferenceChecks, sql` union all `)
    );
    const stillReferenced = remaining.filter((row) => row.remaining > 0);
    if (stillReferenced.length > 0) {
      logger.error('[consolidate-duplicate-catalog-images] aborting batch: lingering references after rewrite', {
        hashes,
        stillReferenced,
      });
      throw new Error(
        `Lingering references after rewrite: ${stillReferenced.map((row) => `${row.location} (${row.remaining})`).join(', ')}`
      );
    }

    const deleted = await tx.execute<{ s3_key: string; byte_size: number }>(sql`
      delete from image_assets
      where id in (select old_id from image_asset_dedup_map)
      returning s3_key, byte_size
    `);

    stats.hashGroupsProcessed += hashes.length;
    stats.rowsDeleted += deleted.length;
    stats.bytesReclaimed += deleted.reduce((sum, row) => sum + row.byte_size, 0);

    return deleted.map((row) => row.s3_key);
  }).catch((err) => {
    logger.error('[consolidate-duplicate-catalog-images] batch failed, skipping', {
      hashes,
      err: describeErrorSafely(err),
    });
    stats.hashGroupsSkipped += hashes.length;
    return [] as string[];
  });

  if (s3KeysToDelete.length > 0) {
    const deletedCount = await deleteFromS3Batch(s3KeysToDelete);
    stats.s3ObjectsDeleted += deletedCount;
  }
}

export async function consolidateDuplicateCatalogImages(
  options: ConsolidationOptions = {}
): Promise<ConsolidationStats> {
  const stats: ConsolidationStats = {
    hashGroupsProcessed: 0,
    hashGroupsSkipped: 0,
    rowsDeleted: 0,
    bytesReclaimed: 0,
    s3ObjectsDeleted: 0,
  };

  let cursor: string | undefined;

  for (;;) {
    if (options.limit !== undefined && stats.hashGroupsProcessed + stats.hashGroupsSkipped >= options.limit) break;

    const hashes = await nextDuplicatedHashes(HASH_BATCH_SIZE, cursor);
    if (hashes.length === 0) break;
    cursor = hashes[hashes.length - 1];

    const remaining =
      options.limit === undefined
        ? hashes.length
        : options.limit - (stats.hashGroupsProcessed + stats.hashGroupsSkipped);
    const batch = hashes.slice(0, Math.max(remaining, 0));
    if (batch.length === 0) break;

    await consolidateBatch(batch, stats, options.dryRun ?? false);
  }

  return stats;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const limitFlag = process.argv.indexOf('--limit');

  let limit: number | undefined;
  if (limitFlag !== -1) {
    limit = Number(process.argv[limitFlag + 1]);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error(
        `--limit needs a non-negative whole number, got ${JSON.stringify(process.argv[limitFlag + 1])}. ` +
          'Refusing to run: an unparseable limit would otherwise mean no limit at all.'
      );
    }
  }

  await connectPostgres();
  logger.info(
    `[consolidate-duplicate-catalog-images] starting${dryRun ? ' (dry run — nothing will be written)' : ''}` +
      `${limit !== undefined ? ` (limit ${limit} duplicate hash groups)` : ''}`
  );

  const stats = await consolidateDuplicateCatalogImages({ dryRun, limit });

  logger.info(
    `[consolidate-duplicate-catalog-images] ${stats.hashGroupsProcessed} hash group(s) consolidated | ` +
      `${stats.hashGroupsSkipped} skipped (lingering reference found) | ` +
      `${stats.rowsDeleted} image_assets row(s) removed | ` +
      `${(stats.bytesReclaimed / 1024 / 1024 / 1024).toFixed(2)} GB reclaimed | ` +
      `${stats.s3ObjectsDeleted} S3 object(s) deleted`
  );

  if (stats.hashGroupsSkipped > 0) {
    logger.warn(
      `[consolidate-duplicate-catalog-images] ${stats.hashGroupsSkipped} hash group(s) were skipped — ` +
        're-running will retry them, but a group that keeps failing means a table with an image ' +
        'reference not listed in REFERENCING_TABLES.'
    );
  }
}

if (require.main === module) {
  main()
    .then(() => closePostgres())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[consolidate-duplicate-catalog-images] fatal', { err: describeErrorSafely(err) });
      closePostgres().finally(() => process.exit(1));
    });
}
