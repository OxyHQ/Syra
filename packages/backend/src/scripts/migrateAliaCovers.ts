/**
 * One-shot: hand Alia's show covers back to Alia (OxyHQ/oxy ADR 0041, phase 4).
 *
 * ## Why this is not part of `migrateImagesToOxy.ts`
 *
 * Alia DRAWS the cover of every show it generates, so the cover is Alia's —
 * and until now Alia had to upload it to Syra (`POST /api/images/upload`, the
 * show owner's token), which left it a Syra image in Syra's bucket. Copying it
 * into Oxy as Syra's file would just move the mistake. Alia copies its covers
 * into its OWN Oxy files instead (Alia's `migrate-show-covers`, reading the exact
 * bytes from `GET /api/images/:id`), and this script then points each show at
 * Alia's file, leaving the legacy image to the bucket's retirement.
 *
 * ## How a show finds Alia's file — with no list handed over
 *
 * For each Alia-generated show (`podcast_sources.provider = 'alia'`) whose
 * cover is still a legacy bucket image, the script hashes its own copy of the
 * bytes, asks Oxy which file holds that SHA-256 (`metadataBySha256`), and
 * accepts it only if Oxy's own record says the file is owned by an application
 * Syra trusts for covers (`SYRA_COVER_APPLICATION_IDS` — Alia), is active and is
 * an image. Same bytes and Alia's ownership, both from Oxy: nothing the caller
 * says decides it. A show whose cover Alia has not copied yet is reported
 * `awaiting_alia` and left as it is; run this again after Alia's step.
 *
 * Then it does what `imageFileId` on `PATCH /api/podcasts/:id` does:
 * references the file as the show (proving Syra may use it), builds its size
 * set and repoints the show's seven image columns.
 *
 * Reports carry show ids and SHA-256 hashes, never a URL or bucket key.
 *
 *   bun run migrate:alia-covers              # preview
 *   bun run migrate:alia-covers -- --apply   # repoint
 */

import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';
import { podcastSources, podcasts } from '../db/schema/podcasts';
import { artworkColumns } from '../services/podcasts/podcastImportService';
import { oxyFiles } from '../services/oxyFiles/client';
import { trustedCoverApplicationIds } from '../services/oxyFiles/adoptedCovers';
import { findOxyImageSet, insertOxyImageSet, measureImage } from '../services/oxyFiles/images';
import {
  readLegacyObject,
  sha256Hex,
  type LegacyObjectReader,
} from '../services/oxyFiles/legacyObjects';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

const BATCH_SIZE = 100;

export type AliaCoverOutcome =
  | 'planned'
  | 'repointed'
  | 'awaiting_alia'
  | 'not_alia_file'
  | 'missing_object'
  | 'not_referenceable'
  | 'failed';

export interface AliaCoverReportLine {
  podcastId: string;
  legacyImageId: string;
  sha256?: string;
  fileId?: string;
  outcome: AliaCoverOutcome;
  reason?: string;
}

export interface AliaCoverOptions {
  apply?: boolean;
  limit?: number;
  readObject?: LegacyObjectReader;
  report?: (line: AliaCoverReportLine) => void;
}

interface AliaShow {
  podcastId: string;
  imageId: string;
  s3Key: string;
}

/** Alia's shows whose cover is still a legacy bucket image, after `after`. */
async function nextShows(after: string | undefined): Promise<AliaShow[]> {
  const rows = await getDb()
    .selectDistinct({ podcastId: podcasts.id, imageId: imageAssets.id, s3Key: imageAssets.s3Key })
    .from(podcasts)
    .innerJoin(podcastSources, eq(podcastSources.podcastId, podcasts.id))
    .innerJoin(imageAssets, eq(imageAssets.id, podcasts.imageId))
    .where(
      and(
        eq(podcastSources.provider, 'alia'),
        isNull(imageAssets.oxyFileId),
        isNotNull(imageAssets.s3Key),
        ...(after === undefined ? [] : [gt(podcasts.id, after)]),
      ),
    )
    .orderBy(asc(podcasts.id))
    .limit(BATCH_SIZE);
  return rows.filter((row): row is AliaShow => row.s3Key !== null);
}

async function handOver(show: AliaShow, options: AliaCoverOptions): Promise<AliaCoverReportLine> {
  const base = { podcastId: show.podcastId, legacyImageId: show.imageId };
  const read = await (options.readObject ?? readLegacyObject)(show.s3Key);
  if (!read) return { ...base, outcome: 'missing_object' };
  const sha256 = sha256Hex(read.bytes);

  const [held] = await oxyFiles().metadataBySha256([sha256]);
  if (!held) return { ...base, sha256, outcome: 'awaiting_alia' };
  const [meta] = await oxyFiles().metadataByIds([held.id]);
  const trusted = trustedCoverApplicationIds();
  if (
    !meta ||
    meta.sha256 !== sha256 ||
    meta.status !== 'active' ||
    !meta.mime.startsWith('image/') ||
    meta.ownerApplicationId === undefined ||
    !trusted.has(meta.ownerApplicationId)
  ) {
    // Somebody holds these bytes, but not a trusted application: never attach
    // another owner's file to the show.
    return { ...base, sha256, outcome: 'not_alia_file' };
  }
  if (!options.apply) return { ...base, sha256, fileId: meta.id, outcome: 'planned' };

  const [reference] = await oxyFiles().references.add([
    { fileId: meta.id, entityType: 'podcast', entityId: show.podcastId },
  ]);
  if (!reference || (reference.result !== 'created' && reference.result !== 'exists')) {
    return { ...base, sha256, fileId: meta.id, outcome: 'not_referenceable' };
  }

  const set =
    (await findOxyImageSet(meta.id)) ??
    (await insertOxyImageSet({
      file: { id: meta.id, sha256: meta.sha256, size: meta.size, mime: meta.mime },
      // The bytes are in hand already: measured here, not read back from Oxy.
      pixels: await measureImage(read.bytes),
      ownerType: 'podcast',
      filename: `cover-${meta.id}`,
    }));

  await getDb()
    .update(podcasts)
    .set({
      ...artworkColumns(set.imageId, set.imageSizes),
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    // Only if the show still has the cover this run looked at.
    .where(and(eq(podcasts.id, show.podcastId), eq(podcasts.imageId, show.imageId)));
  return { ...base, sha256, fileId: meta.id, outcome: 'repointed' };
}

export async function migrateAliaCovers(
  options: AliaCoverOptions = {},
): Promise<Record<AliaCoverOutcome, number>> {
  const stats: Record<AliaCoverOutcome, number> = {
    planned: 0,
    repointed: 0,
    awaiting_alia: 0,
    not_alia_file: 0,
    missing_object: 0,
    not_referenceable: 0,
    failed: 0,
  };
  let handled = 0;
  let after: string | undefined;
  for (;;) {
    const shows = await nextShows(after);
    if (shows.length === 0) break;
    after = shows[shows.length - 1]?.podcastId;
    for (const show of shows) {
      if (options.limit !== undefined && handled >= options.limit) return stats;
      handled += 1;
      let line: AliaCoverReportLine;
      try {
        line = await handOver(show, options);
      } catch (error) {
        line = {
          podcastId: show.podcastId,
          legacyImageId: show.imageId,
          outcome: 'failed',
          reason: String(describeErrorSafely(error)).slice(0, 300),
        };
      }
      stats[line.outcome] += 1;
      options.report?.(line);
    }
  }
  return stats;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const limitIndex = process.argv.indexOf('--limit');
  const limit =
    limitIndex === -1 ? undefined : Number.parseInt(process.argv[limitIndex + 1] ?? '', 10);
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new Error('--limit needs a positive integer');
  }
  if (trustedCoverApplicationIds().size === 0) {
    throw new Error(
      'SYRA_COVER_APPLICATION_IDS is empty: no application is trusted to own a cover',
    );
  }
  await connectPostgres();
  try {
    const stats = await migrateAliaCovers({
      apply,
      ...(limit === undefined ? {} : { limit }),
      report: (line) => logger.info('[migrate-alia-covers]', { ...line }),
    });
    logger.info(`[migrate-alia-covers] ${apply ? 'applied' : 'preview (nothing written)'}`, {
      ...stats,
    });
    if (stats.failed > 0) process.exitCode = 1;
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('[migrate-alia-covers] failed', { error: describeErrorSafely(error) });
    process.exit(1);
  });
}
