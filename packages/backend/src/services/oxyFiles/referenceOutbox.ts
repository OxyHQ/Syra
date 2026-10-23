/**
 * Sends the queued file references to Oxy (`oxy_file_reference_ops`).
 *
 * The queue is written by the database itself (migration `0034`), so this module
 * only has to deliver it: claim a batch under a lease, send the adds and removes
 * in Oxy's batches, and settle each row by what Oxy answered.
 *
 * ## Settling a row
 *
 * - Delivered (`created`/`exists` for an add; `removed`/`not_found` for a
 *   remove — a reference Oxy never had is already removed): deleted, but ONLY if
 *   its `version` is still the one sent. A new intent written while the request
 *   was in flight bumped it, and stays queued.
 * - An add answered `not_found`: the file does not exist or Syra may not
 *   reference it (another application's private file). Retrying cannot change
 *   that, so the row is dead-lettered at once with the reason, kept 30 days for
 *   inspection (`db/expiry.ts`), and the nightly reconciliation reports it under
 *   `refused`.
 * - The request failed (network, 5xx, a token that would not mint): every row of
 *   the batch backs off — one minute doubling to six hours — and is
 *   dead-lettered after {@link MAX_ATTEMPTS}. The reconciliation repairs whatever
 *   a dead row left undone.
 *
 * Several instances drain concurrently: the claim takes rows `FOR UPDATE SKIP
 * LOCKED` and leases them, so no two instances send the same row, and a crashed
 * instance's lease simply runs out.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { ServiceFileReference, ServiceFileReferenceResult } from '@oxy.so/core';
import { getDb, isPostgresConnected } from '../../db/postgres';
import { oxyFileReferenceOps, type OxyReferenceEntityType } from '../../db/schema/oxyFiles';
import { logger } from '../../utils/logger';
import { describeErrorSafely } from '../../utils/error';
import { oxyFiles } from './client';

const BATCH_SIZE = 200;
const LEASE_SECONDS = 120;
export const MAX_ATTEMPTS = 12;
const BACKOFF_BASE_SECONDS = 60;
const BACKOFF_MAX_SECONDS = 6 * 60 * 60;
const BUSY_INTERVAL_MS = 2_000;
const IDLE_INTERVAL_MS = 15_000;

type ClaimedOp = {
  fileId: string;
  entityType: OxyReferenceEntityType;
  entityId: string;
  op: 'add' | 'remove';
  version: number;
  attempts: number;
};

/** Claim up to `limit` due rows for this drainer. */
async function claim(limit: number): Promise<ClaimedOp[]> {
  const rows = await getDb().execute<ClaimedOp>(sql`
    update oxy_file_reference_ops o
    set claimed_until = now() + make_interval(secs => ${LEASE_SECONDS})
    from (
      select file_id, entity_type, entity_id
      from oxy_file_reference_ops
      where dead_at is null
        and next_attempt_at <= now()
        and (claimed_until is null or claimed_until < now())
      order by next_attempt_at
      limit ${limit}
      for update skip locked
    ) due
    where o.file_id = due.file_id
      and o.entity_type = due.entity_type
      and o.entity_id = due.entity_id
    returning o.file_id as "fileId", o.entity_type as "entityType", o.entity_id as "entityId",
      o.op, o.version, o.attempts
  `);
  return [...rows];
}

function keyOf(item: { fileId: string; entityType: string; entityId: string }): string {
  return `${item.fileId}\u0000${item.entityType}\u0000${item.entityId}`;
}

function sameRow(op: ClaimedOp) {
  return and(
    eq(oxyFileReferenceOps.fileId, op.fileId),
    eq(oxyFileReferenceOps.entityType, op.entityType),
    eq(oxyFileReferenceOps.entityId, op.entityId),
    eq(oxyFileReferenceOps.version, op.version),
  );
}

async function settleDelivered(op: ClaimedOp): Promise<void> {
  await getDb().delete(oxyFileReferenceOps).where(sameRow(op));
}

async function settleRefused(op: ClaimedOp, reason: string): Promise<void> {
  await getDb()
    .update(oxyFileReferenceOps)
    .set({
      deadAt: sql`now()`,
      claimedUntil: null,
      lastError: reason,
      attempts: op.attempts + 1,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(sameRow(op));
}

async function settleFailed(op: ClaimedOp, reason: string): Promise<void> {
  const attempts = op.attempts + 1;
  const delay = Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** (attempts - 1));
  await getDb()
    .update(oxyFileReferenceOps)
    .set({
      attempts,
      claimedUntil: null,
      lastError: reason.slice(0, 500),
      nextAttemptAt: sql`now() + make_interval(secs => ${delay})`,
      ...(attempts >= MAX_ATTEMPTS ? { deadAt: sql`now()` } : {}),
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(sameRow(op));
}

/** Send one kind of op, and settle each row by its own result. */
async function deliver(op: 'add' | 'remove', rows: ClaimedOp[]): Promise<void> {
  if (rows.length === 0) return;
  const references: ServiceFileReference[] = rows.map(({ fileId, entityType, entityId }) => ({
    fileId,
    entityType,
    entityId,
  }));
  let results: ServiceFileReferenceResult[];
  try {
    results =
      op === 'add'
        ? await oxyFiles().references.add(references)
        : await oxyFiles().references.remove(references);
  } catch (error) {
    const reason = describeErrorSafely(error);
    logger.warn('[OxyFiles] reference delivery failed; backing off', {
      op,
      rows: rows.length,
      reason,
    });
    for (const row of rows) await settleFailed(row, String(reason));
    return;
  }

  const byKey = new Map(results.map((result) => [keyOf(result), result.result]));
  for (const row of rows) {
    const result = byKey.get(keyOf(row));
    if (result === undefined) {
      await settleFailed(row, 'Oxy did not answer for this reference');
    } else if (op === 'add' && result === 'not_found') {
      await settleRefused(row, 'not_found: no such file, or not one Syra may reference');
    } else {
      await settleDelivered(row);
    }
  }
}

/**
 * Drain one batch. Returns how many rows it claimed, so the loop can tell a busy
 * queue from an empty one.
 */
export async function drainReferenceOutboxOnce(limit = BATCH_SIZE): Promise<number> {
  const claimed = await claim(limit);
  await deliver(
    'add',
    claimed.filter((row) => row.op === 'add'),
  );
  await deliver(
    'remove',
    claimed.filter((row) => row.op === 'remove'),
  );
  return claimed.length;
}

let stopped = true;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start draining on this instance. The shared workload provider resolves identity
 * at delivery time; failed attempts retain the durable queue and its retry policy.
 */
export function startReferenceOutbox(): void {
  if (!stopped) return;

  stopped = false;
  const tick = async () => {
    if (stopped) return;
    let claimed = 0;
    try {
      if (isPostgresConnected()) claimed = await drainReferenceOutboxOnce();
    } catch (error) {
      logger.error('[OxyFiles] reference outbox tick failed', {
        error: describeErrorSafely(error),
      });
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(), claimed > 0 ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS);
    timer.unref();
  };
  timer = setTimeout(() => void tick(), IDLE_INTERVAL_MS);
  timer.unref();
}

export function stopReferenceOutbox(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
