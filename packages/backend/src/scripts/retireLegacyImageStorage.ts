/**
 * The last step of moving Syra's images into Oxy Files: retire the legacy
 * bucket's IMAGE prefixes (`config/s3.config.ts` `LEGACY_IMAGE_PREFIXES`).
 *
 * The bucket itself stays — it still holds every track, episode, locker upload,
 * HLS ladder, preview and room recording, which cannot move until Oxy Files
 * takes audio (`services/oxyFiles/audioStorage.ts` says what Oxy must add). Only the
 * images go.
 *
 * ## The gate — every condition, checked here, every time
 *
 * 1. **Zero legacy reads for {@link SOAK_DAYS} whole days** ({@link SOAK_WAIVER}
 *    shortened that once, for a dated window), and a counted row
 *    for every one of those days: `oxy_files_legacy_reads` gets a row per day
 *    and kind from every running instance even when the count is zero
 *    (`legacyReads.ts`), so "no reads" is told apart from "nothing counting".
 * 2. **No referenced image still bucket-only**: every `image_assets` row an
 *    entity names is in Oxy (or found `missing`, which nothing serves).
 * 3. **No house, room or series image still a bucket URL.**
 *
 * A failing gate deletes nothing and says which condition failed. `--apply` on a
 * passing gate:
 *
 * - clears `s3_key` on every row that is in Oxy (the bucket copy is about to go);
 * - deletes every row that is still bucket-only and that nothing references —
 *   the garbage the migration deliberately did not copy;
 * - deletes every object under the image prefixes.
 *
 * Irreversible, which is why the gate is code and not a checklist. After it,
 * the legacy read path (`imageAssetService.resolveImageAsset`'s fallback,
 * `spaceImageUrl`'s URL branch) has nothing left to serve; removing that code
 * and the `s3_key` / legacy URL columns is a follow-up change of its own
 * (`docs/runbooks/oxy-files-images.md`).
 *
 *   bun run retire:legacy-image-storage            # check the gate, change nothing
 *   bun run retire:legacy-image-storage -- --apply # on a passing gate, retire
 */

import { and, isNotNull, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';
import { LEGACY_IMAGE_READ_KINDS } from '../db/schema/oxyFiles';
import { LEGACY_IMAGE_PREFIXES } from '../config/s3.config';
import { deleteS3Prefix } from '../services/s3Service';
import { cdnUrlToKey } from '../utils/spaces';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

/** Whole days of zero legacy reads the gate requires. */
export const SOAK_DAYS = 14;

/**
 * The owner's waiver of the full soak for THIS retirement — dated, and void
 * outside its window, so it cannot quietly shorten a later run.
 *
 * Granted 2026-10-21 by the product owner. Measured that day in production
 * (`oxy_files_legacy_reads`): the only legacy reads since the images moved were
 * the migration's own — 83 140 `image_asset` reads on 2026-10-17, Oxy importing
 * each set's original through `GET /api/images/:id` — and 2026-10-18, -19 and
 * -20 counted zero on every kind. The soak is those three days; every other
 * condition of the gate is unchanged.
 */
export const SOAK_WAIVER = { from: '2026-10-21', until: '2026-10-25', days: 3 } as const;

/** The soak the gate requires at `now`: {@link SOAK_DAYS}, or the waiver's inside its window. */
export function soakDaysAt(now: Date): number {
  const day = now.toISOString().slice(0, 10);
  return day >= SOAK_WAIVER.from && day < SOAK_WAIVER.until ? SOAK_WAIVER.days : SOAK_DAYS;
}

export interface RetirementGate {
  passed: boolean;
  /** Each condition, by name, and what was measured. */
  checks: {
    legacyReads: { passed: boolean; days: number; daysCounted: number; reads: number };
    bucketOnlyReferencedImages: { passed: boolean; rows: number };
    bucketSpaceImages: { passed: boolean; rows: number };
  };
}

/** The UTC days `[today - soak, today)`, oldest first. */
function soakDays(now: Date, soak: number): string[] {
  const days: string[] = [];
  for (let back = soak; back >= 1; back -= 1) {
    days.push(new Date(now.getTime() - back * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }
  return days;
}

export async function checkRetirementGate(now: Date = new Date()): Promise<RetirementGate> {
  const soak = soakDaysAt(now);
  const days = soakDays(now, soak);
  const [reads] = [
    ...(await getDb().execute<{ reads: number; days_counted: number }>(sql`
      select coalesce(sum(reads), 0)::int as reads,
        count(distinct day) filter (where kinds = ${LEGACY_IMAGE_READ_KINDS.length})::int as days_counted
      from (
        select day, sum(reads) as reads, count(distinct kind) as kinds
        from oxy_files_legacy_reads
        where day >= ${days[0]}::date and day <= ${days[days.length - 1]}::date
        group by day
      ) per_day
    `)),
  ];
  const legacyReads = {
    days: soak,
    daysCounted: reads?.days_counted ?? 0,
    reads: reads?.reads ?? 0,
    passed: (reads?.reads ?? 0) === 0 && (reads?.days_counted ?? 0) === soak,
  };

  const [referenced] = [
    ...(await getDb().execute<{ rows: number }>(sql`
      select count(*)::int as rows
      from image_assets ia
      where ia.oxy_file_id is null and ia.s3_key is not null and ia.serving_status = 'active'
        and exists (select 1 from oxy_image_asset_users(array[ia.id]))
    `)),
  ];
  const bucketOnlyReferencedImages = {
    rows: referenced?.rows ?? 0,
    passed: (referenced?.rows ?? 0) === 0,
  };

  const spaceUrls = [
    ...(await getDb().execute<{ url: string }>(sql`
      select avatar as url from houses where avatar is not null and avatar_file_id is null
      union all select cover_image from houses where cover_image is not null and cover_image_file_id is null
      union all select stream_image from rooms where stream_image is not null and stream_image_file_id is null
      union all select cover_image from series where cover_image is not null and cover_image_file_id is null
    `)),
  ];
  const bucketSpaceRows = spaceUrls.filter((row) => cdnUrlToKey(row.url) !== null).length;
  const bucketSpaceImages = { rows: bucketSpaceRows, passed: bucketSpaceRows === 0 };

  return {
    passed: legacyReads.passed && bucketOnlyReferencedImages.passed && bucketSpaceImages.passed,
    checks: { legacyReads, bucketOnlyReferencedImages, bucketSpaceImages },
  };
}

export interface RetirementResult {
  gate: RetirementGate;
  applied: boolean;
  s3KeysCleared: number;
  unreferencedRowsDeleted: number;
  objectsDeleted: number;
}

export async function retireLegacyImageStorage(
  options: { apply?: boolean; now?: Date; deletePrefix?: (prefix: string) => Promise<number> } = {},
): Promise<RetirementResult> {
  const gate = await checkRetirementGate(options.now);
  const result: RetirementResult = {
    gate,
    applied: false,
    s3KeysCleared: 0,
    unreferencedRowsDeleted: 0,
    objectsDeleted: 0,
  };
  if (!gate.passed || !options.apply) return result;

  await getDb().transaction(async (tx) => {
    result.s3KeysCleared = (
      await tx
        .update(imageAssets)
        .set({ s3Key: null, updatedAt: sql`date_trunc('milliseconds', now())` })
        .where(and(isNotNull(imageAssets.oxyFileId), isNotNull(imageAssets.s3Key)))
        .returning({ id: imageAssets.id })
    ).length;
    result.unreferencedRowsDeleted = (
      await tx.execute<{ id: string }>(sql`
        delete from image_assets ia
        where ia.oxy_file_id is null and ia.s3_key is not null and ia.serving_status = 'active'
          and not exists (select 1 from oxy_image_asset_users(array[ia.id]))
        returning ia.id
      `)
    ).length;
  });

  const deletePrefix = options.deletePrefix ?? deleteS3Prefix;
  for (const prefix of LEGACY_IMAGE_PREFIXES) {
    result.objectsDeleted += await deletePrefix(prefix);
  }
  result.applied = true;
  return result;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await connectPostgres();
  try {
    const result = await retireLegacyImageStorage({ apply });
    logger.info('[retire-legacy-image-storage]', { ...result });
    if (!result.gate.passed) {
      logger.warn('[retire-legacy-image-storage] the gate is not met; nothing was deleted');
      process.exitCode = apply ? 1 : 0;
    }
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('[retire-legacy-image-storage] failed', { error: describeErrorSafely(error) });
    process.exit(1);
  });
}
