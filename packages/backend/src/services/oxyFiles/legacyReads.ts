/**
 * How many image reads are still answered from Syra's legacy bucket — the number
 * the bucket's image prefixes are retired on (`docs/runbooks/oxy-files-images.md`).
 *
 * Counted in memory and flushed once a minute — every kind, zeros included — two
 * ways:
 *
 * - into `oxy_files_legacy_reads` (one row per day and kind), which is what
 *   `scripts/retireLegacyImageStorage.ts` checks before it deletes anything — a
 *   gate a script can evaluate, not a dashboard someone has to remember;
 * - as one CloudWatch Embedded Metric Format line per kind
 *   (`Syra/OxyFiles` · `LegacyImageReads` · dimension `Kind`), for alarms.
 *
 * A read is counted where Syra decides to use the legacy copy: `/api/images/:id`
 * streaming a bucket object, and a house/room/series DTO handing out a bucket URL
 * (those are fetched by the client straight from the bucket, so the hand-out is
 * the only place Syra sees them).
 */

import { sql } from 'drizzle-orm';
import { getDb, isPostgresConnected } from '../../db/postgres';
import {
  LEGACY_IMAGE_READ_KINDS,
  oxyFilesLegacyReads,
  type LegacyImageReadKind,
} from '../../db/schema/oxyFiles';
import { logger } from '../../utils/logger';
import { describeErrorSafely } from '../../utils/error';

const FLUSH_INTERVAL_MS = 60_000;

/** Reads counted since the last flush — each one reaches the metric exactly once. */
const pending = new Map<LegacyImageReadKind, number>();
/** Reads already sent to the metric whose database write has not succeeded yet. */
const unpersisted = new Map<LegacyImageReadKind, number>();

export function recordLegacyRead(kind: LegacyImageReadKind, count = 1): void {
  pending.set(kind, (pending.get(kind) ?? 0) + count);
}

/** The counts not flushed yet (including any whose write failed). For tests. */
export function pendingLegacyReads(): ReadonlyMap<LegacyImageReadKind, number> {
  const all = new Map(unpersisted);
  for (const [kind, reads] of pending) all.set(kind, (all.get(kind) ?? 0) + reads);
  return all;
}

/**
 * Write the counts out. A count that fails to persist is kept for the next
 * flush, so a database blip delays it rather than losing it: a retirement gate
 * that under-counts is the one failure this module must not have.
 */
export async function flushLegacyReads(now: Date = new Date()): Promise<void> {
  // EVERY kind, zeros included: a day with a row and zero reads is evidence the
  // counter was running, which an absent row is not. The retirement gate needs
  // the difference — silence because nothing read the bucket, not because
  // nothing was counting.
  const fresh = LEGACY_IMAGE_READ_KINDS.map((kind) => [kind, pending.get(kind) ?? 0] as const);
  pending.clear();

  for (const [kind, reads] of fresh) {
    // EMF: CloudWatch Logs turns this line into a metric with no agent.
    logger.info('[OxyFiles] legacy image reads', {
      _aws: {
        Timestamp: now.getTime(),
        CloudWatchMetrics: [
          {
            Namespace: 'Syra/OxyFiles',
            Dimensions: [['Kind']],
            Metrics: [{ Name: 'LegacyImageReads', Unit: 'Count' }],
          },
        ],
      },
      Kind: kind,
      LegacyImageReads: reads,
    });
    unpersisted.set(kind, (unpersisted.get(kind) ?? 0) + reads);
  }

  if (!isPostgresConnected()) return;
  const day = now.toISOString().slice(0, 10);
  const batch = LEGACY_IMAGE_READ_KINDS.map((kind) => ({
    day,
    kind,
    reads: unpersisted.get(kind) ?? 0,
  }));
  try {
    await getDb()
      .insert(oxyFilesLegacyReads)
      .values(batch)
      .onConflictDoUpdate({
        target: [oxyFilesLegacyReads.day, oxyFilesLegacyReads.kind],
        set: {
          reads: sql`${oxyFilesLegacyReads.reads} + excluded.reads`,
          updatedAt: sql`date_trunc('milliseconds', now())`,
        },
      });
    unpersisted.clear();
  } catch (error) {
    logger.warn('[OxyFiles] could not persist legacy read counts; kept for the next flush', {
      error: describeErrorSafely(error),
    });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startLegacyReadFlusher(): void {
  if (timer) return;
  timer = setInterval(() => void flushLegacyReads(), FLUSH_INTERVAL_MS);
  timer.unref();
}

export async function stopLegacyReadFlusher(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await flushLegacyReads();
}
