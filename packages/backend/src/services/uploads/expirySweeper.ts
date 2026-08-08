/**
 * Retention for the private locker: warn, hide, then delete.
 *
 * A locker file lives for a year from the last time it was played, so storage is
 * paid for music somebody actually listens to. The schedule has three stops and
 * every one of them exists for a reason:
 *
 *  - **T−14d — notice.** The owner is told before anything is removed. A silent
 *    deletion of a file somebody uploaded to preserve is the one outcome this
 *    whole feature cannot afford.
 *  - **T0 — soft delete.** `deletedAt` is stamped; the file stops appearing and
 *    stops streaming, but the bytes stay in S3. Recoverable while a support
 *    request is still plausible.
 *  - **T+30d — hard delete.** Stored objects AND the document go, together.
 *
 * `expiresAt` is `max(lastPlayedAt, createdAt) + 365d`, recomputed on every play
 * by {@link recordUploadPlay}, so listening to a file is what keeps it.
 *
 * Deliberately NOT registered with `db/expiry.ts`'s sweep (see the note on
 * `user_uploads.expires_at` in `schema/creators.ts`): a blind row delete skips
 * the notice entirely and orphans every S3 object behind every deleted row.
 *
 * The tick takes a Postgres advisory lock so exactly one ECS task in the fleet
 * sweeps. The lock is in Postgres rather than Redis — unlike the recommendation
 * and podcast schedulers, which skip a tick when Redis is down — because this
 * job DELETES. Its correctness depends on the same store it is deleting from
 * being reachable, and putting the mutual exclusion anywhere else means adding a
 * second thing that can be down while the deletes still run. That reasoning is
 * inherited verbatim from the Mongo lease row this replaces; see
 * {@link acquireSweepLock} for what changed and why it is strictly better.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { describeDriverError } from '@oxyhq/db';
import { getDb, getPostgresClient, isDriverError } from '../../db/postgres';
import { userUploads } from '../../db/schema/creators';
import {
  deleteUploads,
  findExpiredUploadIds,
  findUploadsDueForNotice,
  findUploadsPastGrace,
  markDeletionNoticeSent,
  softDeleteUploads,
  type UploadStorageRef,
} from '../../db/creators/uploads';
import { deleteUploadStoredObjects } from '../compliance/takedown';
import { notifyUser } from '../notifications/notifier';
import { logger } from '../../utils/logger';
import { describeErrorSafely } from '../../utils/error';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a locker file survives without being played. */
export const UPLOAD_RETENTION_DAYS = 365;
/** How far ahead of expiry the owner is warned. */
export const DELETION_NOTICE_LEAD_DAYS = 14;
/** How long the bytes survive the soft delete before they are really gone. */
export const HARD_DELETE_GRACE_DAYS = 30;

/** Rows touched per phase per tick, so one sweep cannot run unbounded. */
const SWEEP_BATCH_SIZE = 500;

/** How often the tick fires on each instance. */
const TICK_INTERVAL_MS = 60 * 60 * 1000;
/** First tick is delayed so it never competes with cold-start boot work. */
const INITIAL_DELAY_MS = 5 * 60 * 1000;
// There is no lock lease any more, and therefore no TTL constant. The Mongo
// version needed one because a lease has to guess how long the work takes; a
// session advisory lock is released by the connection dropping, so a crashed
// task frees it exactly and a slow sweep never outlives its own claim. See
// `acquireSweepLock`.

// ── Expiry arithmetic ────────────────────────────────────────────────────────

/**
 * When this file expires: a year after the later of its last play and its upload.
 *
 * `createdAt` participates so a file that has NEVER been played still gets its
 * full year — `lastPlayedAt` is absent until the first play, and treating absence
 * as epoch would expire every untouched upload immediately.
 */
export function computeUploadExpiry(upload: {
  createdAt: Date;
  lastPlayedAt?: Date | null;
}): Date {
  const lastPlayed = upload.lastPlayedAt?.getTime() ?? 0;
  const created = upload.createdAt.getTime();
  return new Date(Math.max(lastPlayed, created) + UPLOAD_RETENTION_DAYS * DAY_MS);
}

/**
 * Record a play and push the expiry a full year out.
 *
 * Scoped to the owner in the same query rather than after a separate read: the
 * caller has an id from a request, and the owner check and the write have to be
 * the same operation or there is a window between them. Returns false when
 * nothing matched — a wrong owner, a missing id, or an already soft-deleted file.
 *
 * `deletionNoticeSentAt` is cleared because a notice is about ONE expiry window.
 * Leaving it set would mean the file silently skips its warning the next time it
 * approaches deletion, a year later.
 */
export async function recordUploadPlay(
  uploadId: string,
  ownerOxyUserId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const played = await getDb()
    .update(userUploads)
    .set({
      lastPlayedAt: now,
      expiresAt: new Date(now.getTime() + UPLOAD_RETENTION_DAYS * DAY_MS),
      // `$inc` in the database, not a read-modify-write: two devices starting
      // the same file at once must count two plays.
      playCount: sql`${userUploads.playCount} + 1`,
      // `$unset` becomes an explicit null. A notice is about ONE expiry window;
      // leaving it set would mean the file silently skips its warning the next
      // time it approaches deletion, a year later.
      deletionNoticeSentAt: null,
    })
    .where(
      and(
        eq(userUploads.id, uploadId),
        eq(userUploads.ownerOxyUserId, ownerOxyUserId),
        isNull(userUploads.deletedAt)
      )
    )
    .returning({ id: userUploads.id });

  return played.length > 0;
}

// ── Lock ─────────────────────────────────────────────────────────────────────

/**
 * The advisory-lock key for this sweep.
 *
 * A fixed, arbitrary number that identifies the job — advisory locks share one
 * namespace per database, so this value is the whole name. Written as a literal
 * rather than hashed from `'uploads:expiry'` at runtime: a hash makes the value
 * invisible in `pg_locks`, where the only way to answer "who holds this" is to
 * compare the number against something written down. It is well inside int32,
 * so it reaches the `bigint` overload as an ordinary parameter.
 */
const SWEEP_LOCK_KEY = 704_213_001;

/**
 * Claim the sweep for this instance, or report that somebody else holds it.
 *
 * A SESSION-scoped `pg_try_advisory_lock`, which is strictly better than the
 * Mongo lease row it replaces and needs no table at all:
 *
 *  - `try` never blocks. A losing instance is told immediately and skips the
 *    tick, exactly as the losing upsert did.
 *  - There is no TTL to tune, and no lease TTL that a sweep could
 *    outlive. A lease has to guess how long the work takes; guess short and two
 *    instances sweep at once, guess long and a crashed task wedges the job.
 *  - A task that dies mid-sweep drops its connection, and Postgres releases the
 *    lock with it. That is the property the lease was approximating with an
 *    expiry, and here it is exact.
 *
 * It needs a RESERVED connection because the lock lives on a session and the
 * pool hands out a different backend per query — take it on one connection and
 * release it on another and the release is a no-op that logs a warning, leaving
 * the lock held until the first connection happens to be recycled. That is why
 * this is the one place in the codebase reaching past `getDb()`.
 */
type SweepLock = { release: () => Promise<void> };

async function acquireSweepLock(): Promise<SweepLock | undefined> {
  const reserved = await getPostgresClient().reserve();
  try {
    const [claimed] = await reserved<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${SWEEP_LOCK_KEY}) as locked
    `;
    if (!claimed?.locked) {
      reserved.release();
      return undefined;
    }
  } catch (err) {
    reserved.release();
    throw err;
  }

  return {
    release: async () => {
      try {
        // Only the holder can release a session lock — Postgres enforces that
        // for us, which is what the Mongo version's `holder` filter was for.
        await reserved`select pg_advisory_unlock(${SWEEP_LOCK_KEY})`;
      } finally {
        // Returns the connection to the pool. Distinct from the unlock above:
        // dropping the reservation without unlocking would leave the lock held
        // by whatever the pool hands that backend to next.
        reserved.release();
      }
    },
  };
}

// ── Sweep ────────────────────────────────────────────────────────────────────

export interface ExpirySweepDeps {
  /** Injected so the whole schedule is testable without waiting a year. */
  now?: () => Date;
  /** Delete one file's stored objects; defaults to the compliance purge helper. */
  deleteObjects?: (upload: UploadStorageRef) => Promise<number>;
  /** Tell one owner their files are about to go; defaults to the Syra notifier. */
  notify?: (input: ExpiryNoticeInput) => Promise<void>;
}

export interface ExpiryNoticeInput {
  ownerOxyUserId: string;
  /** How many of this owner's files are inside the notice window. */
  uploadCount: number;
  /** The soonest expiry among them — what the message should lead with. */
  earliestExpiresAt: Date;
  /** Ids of the files this notice covers. */
  uploadIds: string[];
}

export interface ExpirySweepResult {
  /** False when another instance held the lock; every count is then zero. */
  ran: boolean;
  ownersNotified: number;
  uploadsNoticed: number;
  uploadsSoftDeleted: number;
  uploadsHardDeleted: number;
  objectsDeleted: number;
}

const EMPTY_RESULT: ExpirySweepResult = {
  ran: false,
  ownersNotified: 0,
  uploadsNoticed: 0,
  uploadsSoftDeleted: 0,
  uploadsHardDeleted: 0,
  objectsDeleted: 0,
};

async function defaultNotify(input: ExpiryNoticeInput): Promise<void> {
  const plural = input.uploadCount === 1 ? 'file' : 'files';
  await notifyUser({
    recipientId: input.ownerOxyUserId,
    // Nothing else caused this — the passage of time did. The owner is both the
    // recipient and the only party involved.
    actorId: input.ownerOxyUserId,
    event: 'upload.expiring',
    entityId: input.uploadIds[0] ?? input.ownerOxyUserId,
    entityType: 'upload',
    title: `${input.uploadCount} uploaded ${plural} expiring`,
    message:
      `${input.uploadCount} ${plural} in your library will be removed after ` +
      `${input.earliestExpiresAt.toISOString().slice(0, 10)} because ` +
      `${input.uploadCount === 1 ? 'it has' : 'they have'} not been played for a year. ` +
      `Play ${input.uploadCount === 1 ? 'it' : 'them'} to keep ${input.uploadCount === 1 ? 'it' : 'them'}.`,
    data: { uploadIds: input.uploadIds },
    // One notice per owner per window, however many files are in it: a library
    // clear-out should not be N pushes.
    coalesceGroupId: `upload-expiry:${input.ownerOxyUserId}`,
    coalesceWindowMs: DELETION_NOTICE_LEAD_DAYS * DAY_MS,
  });
}

/**
 * Phase 1 — warn every owner whose files enter the notice window.
 *
 * Grouped by owner and sent once, rather than once per file: the same clear-out
 * that makes the notice worth sending is the one that would otherwise send fifty
 * of them. Every file in the batch is stamped whether or not the notification
 * itself was delivered — `notifyUser` swallows delivery failures by contract, and
 * re-stamping on the next tick would re-send to everyone who did get it.
 */
async function sweepNotices(
  now: Date,
  notify: (input: ExpiryNoticeInput) => Promise<void>,
): Promise<{ ownersNotified: number; uploadsNoticed: number }> {
  const noticeHorizon = new Date(now.getTime() + DELETION_NOTICE_LEAD_DAYS * DAY_MS);

  const due = await findUploadsDueForNotice(now, noticeHorizon, SWEEP_BATCH_SIZE);

  if (due.length === 0) return { ownersNotified: 0, uploadsNoticed: 0 };

  const byOwner = new Map<string, { ids: string[]; earliest: Date }>();
  for (const upload of due) {
    // The range filter already excludes a null `expires_at`, so this guard is
    // the type narrowing rather than a second predicate.
    if (!upload.expiresAt) continue;
    const entry = byOwner.get(upload.ownerOxyUserId);
    if (entry) {
      entry.ids.push(upload.id);
      if (upload.expiresAt < entry.earliest) entry.earliest = upload.expiresAt;
    } else {
      byOwner.set(upload.ownerOxyUserId, { ids: [upload.id], earliest: upload.expiresAt });
    }
  }

  let uploadsNoticed = 0;
  for (const [ownerOxyUserId, { ids, earliest }] of byOwner) {
    await notify({
      ownerOxyUserId,
      uploadCount: ids.length,
      earliestExpiresAt: earliest,
      uploadIds: ids,
    });
    uploadsNoticed += await markDeletionNoticeSent(ids, now);
  }

  return { ownersNotified: byOwner.size, uploadsNoticed };
}

/** Phase 2 — hide expired files. Bytes stay; only the row is stamped. */
async function sweepSoftDeletes(now: Date): Promise<number> {
  // Selected and then updated by id, rather than one `UPDATE … WHERE expires_at
  // <= now`, because the batch cap is what keeps one tick bounded and a bare
  // UPDATE has no LIMIT.
  const expired = await findExpiredUploadIds(now, SWEEP_BATCH_SIZE);
  return softDeleteUploads(expired, now);
}

/**
 * Phase 3 — delete the bytes, then the document.
 *
 * That order, never the reverse: a failure after the objects are gone leaves a
 * row pointing at nothing, which the next tick retries harmlessly. A failure
 * after the row is gone leaves audio in the bucket that nothing will ever name
 * again.
 */
async function sweepHardDeletes(
  now: Date,
  deleteObjects: (upload: UploadStorageRef) => Promise<number>,
): Promise<{ uploadsHardDeleted: number; objectsDeleted: number }> {
  const graceCutoff = new Date(now.getTime() - HARD_DELETE_GRACE_DAYS * DAY_MS);

  /**
   * A projection, never `fingerprint` — see {@link UploadStorageRef}.
   *
   * These rows are loaded only to be deleted, and the delete helper takes a
   * structural storage ref. A locker fingerprint is thousands of int32s per row
   * and the sweep walks up to `SWEEP_BATCH_SIZE` of them per tick — pulling that
   * across the wire to read three key fields is the whole batch's cost.
   */
  const doomed = await findUploadsPastGrace(graceCutoff, SWEEP_BATCH_SIZE);

  let uploadsHardDeleted = 0;
  let objectsDeleted = 0;

  for (const upload of doomed) {
    try {
      objectsDeleted += await deleteObjects(upload);
    } catch (err) {
      // Keep the row: it is the only remaining record of which objects still
      // need deleting. The next tick tries again.
      logger.error('[uploads] failed to delete stored objects for expired upload', {
        uploadId: upload.id,
        err: describeErrorSafely(err),
      });
      continue;
    }

    /**
     * The row, its HLS ladder, its provenance markers AND its AES key.
     *
     * That last one is the defect this sweep used to carry: `track_keys` was
     * polymorphic across three id spaces and could hold no foreign key, so
     * nothing cascaded, and the AES key of every file this loop removed stayed
     * behind forever — keyed by an id that resolved to nothing. The manual
     * `DELETE /api/uploads/:id` path had an explicit delete for it and this one
     * never did.
     *
     * It is fixed by a constraint rather than by a second explicit delete here,
     * which is why this line does not grow one: `track_keys.user_upload_id` is
     * a real `ON DELETE cascade` reference (`schema/trackKeys.ts`), so the key
     * goes with the row for this caller and for every caller after it.
     */
    uploadsHardDeleted += await deleteUploads([upload.id]);
  }

  return { uploadsHardDeleted, objectsDeleted };
}

/**
 * Run one sweep, under the fleet lock.
 *
 * Returns `{ ran: false }` when another instance holds the lock — a skipped tick,
 * not a failure; the work is still there an hour later.
 */
export async function runExpirySweep(deps: ExpirySweepDeps = {}): Promise<ExpirySweepResult> {
  const now = deps.now?.() ?? new Date();
  const deleteObjects = deps.deleteObjects ?? ((upload) => deleteUploadStoredObjects(upload));
  const notify = deps.notify ?? defaultNotify;

  const lock = await acquireSweepLock();
  if (!lock) {
    return { ...EMPTY_RESULT };
  }

  try {
    const notices = await sweepNotices(now, notify);
    const uploadsSoftDeleted = await sweepSoftDeletes(now);
    const hard = await sweepHardDeletes(now, deleteObjects);

    return {
      ran: true,
      ownersNotified: notices.ownersNotified,
      uploadsNoticed: notices.uploadsNoticed,
      uploadsSoftDeleted,
      uploadsHardDeleted: hard.uploadsHardDeleted,
      objectsDeleted: hard.objectsDeleted,
    };
  } finally {
    await lock.release();
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

let started = false;
let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return; // never overlap on the same instance
  running = true;
  try {
    const result = await runExpirySweep();
    if (result.ran && (result.uploadsNoticed || result.uploadsSoftDeleted || result.uploadsHardDeleted)) {
      logger.info('[uploads] expiry sweep', result);
    }
  } catch (err) {
    /**
     * The tick's only catch, and the sweep it wraps deletes rows, takes an
     * advisory lock and reaches S3 — so this is the same classifier question
     * the ingest path answers. A failing DELETE carries its `WHERE` and every
     * bound id; a lock or storage failure carries the reason.
     */
    if (isDriverError(err)) {
      logger.error('[uploads] expiry sweep failed: the database refused a statement', {
        driver: describeDriverError(err),
      });
    } else {
      logger.error('[uploads] expiry sweep failed', { err: describeErrorSafely(err) });
    }
  } finally {
    running = false;
  }
}

/**
 * Start the retention sweeper on this instance. Idempotent.
 *
 * Both timers are `unref`'d: a module-level interval that keeps the event loop
 * alive hangs a test run non-deterministically (see ~/Oxy/AGENTS.md), and the
 * sweep has nothing to finish that would justify holding the process open.
 */
export function startExpirySweeper(): void {
  if (started) return;
  started = true;

  setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
    timer.unref?.();
  }, INITIAL_DELAY_MS).unref?.();

  logger.info('[uploads] expiry sweeper started', {
    intervalMinutes: TICK_INTERVAL_MS / 60000,
    retentionDays: UPLOAD_RETENTION_DAYS,
  });
}

/** Stop the sweeper (tests, graceful shutdown). */
export function stopExpirySweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}
