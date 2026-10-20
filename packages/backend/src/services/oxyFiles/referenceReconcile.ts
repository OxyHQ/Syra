/**
 * The nightly inventory: Syra's real use of Oxy files, sent to Oxy one entity
 * type at a time (OxyHQ/oxy ADR 0043 D6).
 *
 * The triggers and the outbox register every use as it happens; this is the
 * safety net under them — a reference a dead-lettered row never delivered, a row
 * a script changed with the triggers off, a reference Oxy holds for an entity
 * that no longer exists. Oxy adds what the inventory lists and it lacks, and
 * removes what it holds, created before the inventory began, that the inventory
 * does not list. It never trashes a file for it; an application file left with
 * no reference is collected by Oxy's own lifecycle 24 hours later, which is the
 * point.
 *
 * ## The inventory is the triggers' own resolution
 *
 * Generated from `referenceRegistry.ts`, the list the triggers were created from
 * (a test holds the two equal), so the nightly answer and the per-write answer
 * cannot disagree about what "uses a file" means.
 *
 * ## Always applied
 *
 * The nightly run always applies: there is no mode to set. An operator who
 * wants the counts first runs the on-demand preview below, which changes
 * nothing.
 *
 * ## Once a day, fleet-wide
 *
 * Each instance ticks hourly; a Postgres advisory lock lets one run at a time,
 * and `oxy_file_reconcile_runs` records each entity type's last run, so a type is
 * inventoried again only 24 hours after it last finished — on whichever instance
 * gets there first.
 *
 * ## On demand
 *
 * {@link reconcileAllNow} runs every entity type at once under the same lock
 * (`scripts/reconcileOxyFileReferences.ts`, through `run-backend-script.yml`),
 * for an operator who has just moved data and wants the counts now. Its dry
 * run is not recorded as a run: it would push the night's real run a day out.
 */

import { sql } from 'drizzle-orm';
import type { ServiceReferenceInventoryItem } from '@oxy.so/core';
import { getDb, getPostgresClient, isPostgresConnected } from '../../db/postgres';
import {
  OXY_REFERENCE_ENTITY_TYPES,
  oxyFileReconcileRuns,
  type OxyReferenceEntityType,
} from '../../db/schema/oxyFiles';
import { canAuthenticateAsOxyService } from '../../oxyClient';
import { logger } from '../../utils/logger';
import { describeErrorSafely } from '../../utils/error';
import { oxyFiles } from './client';
import { inventoryQuery, lastEntityIdOfPage, referenceSource } from './referenceRegistry';

const PAGE_SIZE = 2_000;
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;
const TICK_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_DELAY_MS = 10 * 60 * 1000;
/** Distinct from every other advisory lock key in this database. */
const RECONCILE_LOCK_KEY = 0x0f11e5;

/** Every `{ fileId, entityId }` Syra uses for one entity type, streamed by entity id. */
export async function* referenceInventory(
  entityType: OxyReferenceEntityType,
  pageSize = PAGE_SIZE,
): AsyncGenerator<ServiceReferenceInventoryItem> {
  const source = referenceSource(entityType);
  let after: string | null = null;
  for (;;) {
    const pages: { lastId: string | null; count: number }[] = [
      ...(await getDb().execute<{ lastId: string | null; count: number }>(
        lastEntityIdOfPage(source, after, pageSize),
      )),
    ];
    const page = pages[0];
    if (!page || page.count === 0 || page.lastId === null) return;
    const items = await getDb().execute<{ fileId: string; entityId: string }>(
      inventoryQuery(source, after, pageSize),
    );
    for (const item of items) yield { fileId: item.fileId, entityId: item.entityId };
    if (page.count < pageSize) return;
    after = page.lastId;
  }
}

export interface ReconcileOutcome {
  entityType: OxyReferenceEntityType;
  dryRun: boolean;
  added: number;
  removed: number;
  unchanged: number;
  refused: number;
}

/**
 * Reconcile one entity type now, and record it — unless `record` is false (an
 * operator's preview, which must not stand in for the night's run).
 */
export async function reconcileEntityType(
  entityType: OxyReferenceEntityType,
  dryRun: boolean,
  { record = true }: { record?: boolean } = {},
): Promise<ReconcileOutcome> {
  if (!record) {
    const result = await oxyFiles().references.reconcile(
      entityType,
      referenceInventory(entityType),
      { dryRun },
    );
    return {
      entityType,
      dryRun: result.dryRun,
      added: result.added,
      removed: result.removed,
      unchanged: result.unchanged,
      refused: result.refused,
    };
  }
  await getDb()
    .insert(oxyFileReconcileRuns)
    .values({ entityType, startedAt: new Date(), dryRun, finishedAt: null, lastError: null })
    .onConflictDoUpdate({
      target: oxyFileReconcileRuns.entityType,
      set: { startedAt: new Date(), dryRun, lastError: null },
    });
  try {
    const result = await oxyFiles().references.reconcile(
      entityType,
      referenceInventory(entityType),
      {
        dryRun,
      },
    );
    await getDb()
      .update(oxyFileReconcileRuns)
      .set({
        finishedAt: new Date(),
        added: result.added,
        removed: result.removed,
        unchanged: result.unchanged,
        refused: result.refused,
      })
      .where(sql`${oxyFileReconcileRuns.entityType} = ${entityType}`);
    logger.info('[OxyFiles] references reconciled', { ...result });
    return {
      entityType,
      dryRun: result.dryRun,
      added: result.added,
      removed: result.removed,
      unchanged: result.unchanged,
      refused: result.refused,
    };
  } catch (error) {
    await getDb()
      .update(oxyFileReconcileRuns)
      .set({ lastError: String(describeErrorSafely(error)).slice(0, 500) })
      .where(sql`${oxyFileReconcileRuns.entityType} = ${entityType}`);
    throw error;
  }
}

/** The entity types whose last run finished more than a day ago (or never). */
async function dueEntityTypes(now: Date): Promise<OxyReferenceEntityType[]> {
  const rows = await getDb()
    .select({
      entityType: oxyFileReconcileRuns.entityType,
      finishedAt: oxyFileReconcileRuns.finishedAt,
    })
    .from(oxyFileReconcileRuns);
  const finished = new Map(rows.map((row) => [row.entityType, row.finishedAt]));
  return OXY_REFERENCE_ENTITY_TYPES.filter((entityType) => {
    const last = finished.get(entityType);
    return !last || now.getTime() - last.getTime() >= RUN_EVERY_MS;
  });
}

/** Run `work` under the fleet-wide reconcile lock; `null` when another run holds it. */
async function withReconcileLock<T>(work: () => Promise<T>): Promise<T | null> {
  const reserved = await getPostgresClient().reserve();
  try {
    const [claimed] = await reserved<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${RECONCILE_LOCK_KEY}) as locked
    `;
    if (!claimed?.locked) return null;
    try {
      return await work();
    } finally {
      await reserved`select pg_advisory_unlock(${RECONCILE_LOCK_KEY})`;
    }
  } finally {
    reserved.release();
  }
}

/** One tick: under the lock, reconcile every due entity type. */
export async function runDueReconciliations(now: Date = new Date()): Promise<ReconcileOutcome[]> {
  const outcomes = await withReconcileLock(async () => {
    const done: ReconcileOutcome[] = [];
    for (const entityType of await dueEntityTypes(now)) {
      try {
        done.push(await reconcileEntityType(entityType, false));
      } catch (error) {
        logger.error('[OxyFiles] reconciliation failed', {
          entityType,
          error: describeErrorSafely(error),
        });
      }
    }
    return done;
  });
  return outcomes ?? [];
}

export interface ReconcileAllResult {
  outcomes: ReconcileOutcome[];
  failed: Array<{ entityType: OxyReferenceEntityType; error: string }>;
}

/**
 * Every entity type, now, under the nightly run's lock: `busy` while another
 * run holds it. A dry run is not recorded (see "On demand"); an applied run
 * is, and counts as the night's.
 */
export async function reconcileAllNow(dryRun: boolean): Promise<ReconcileAllResult | 'busy'> {
  const result = await withReconcileLock(async () => {
    const all: ReconcileAllResult = { outcomes: [], failed: [] };
    for (const entityType of OXY_REFERENCE_ENTITY_TYPES) {
      try {
        all.outcomes.push(await reconcileEntityType(entityType, dryRun, { record: !dryRun }));
      } catch (error) {
        all.failed.push({ entityType, error: String(describeErrorSafely(error)) });
      }
    }
    return all;
  });
  return result ?? 'busy';
}

let timer: ReturnType<typeof setInterval> | null = null;
let first: ReturnType<typeof setTimeout> | null = null;

export function startReferenceReconciler(): void {
  if (timer || first) return;
  if (!canAuthenticateAsOxyService()) {
    logger.warn('[OxyFiles] no Oxy service identity: nightly reference reconciliation is off');
    return;
  }
  const tick = () => {
    if (!isPostgresConnected()) return;
    void runDueReconciliations().catch((error: unknown) =>
      logger.error('[OxyFiles] reconciliation tick failed', { error: describeErrorSafely(error) }),
    );
  };
  first = setTimeout(() => {
    first = null;
    tick();
    timer = setInterval(tick, TICK_INTERVAL_MS);
    timer.unref();
  }, INITIAL_DELAY_MS);
  first.unref();
}

export function stopReferenceReconciler(): void {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = null;
  timer = null;
}
