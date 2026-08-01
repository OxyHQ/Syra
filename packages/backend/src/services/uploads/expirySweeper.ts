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
 * Deliberately NOT a Mongo TTL index (see the note on `UserUpload.expiresAt`): a
 * TTL index deletes documents without running application code, which would skip
 * the notice entirely and orphan every S3 object behind every deleted row.
 *
 * The tick takes a Mongo lock so exactly one ECS task in the fleet sweeps. The
 * lock is in Mongo rather than Redis — unlike the recommendation and podcast
 * schedulers, which skip a tick when Redis is down — because this job DELETES.
 * Its correctness depends on the same store it is deleting from being reachable,
 * and putting the mutual exclusion anywhere else means adding a second thing that
 * can be down while the deletes still run.
 */

import mongoose, { Schema, type Document } from 'mongoose';
import { UserUploadModel } from '../../models/UserUpload';
import { deleteUploadStoredObjects, type UploadStorageRef } from '../compliance/takedown';
import { notifyUser } from '../notifications/notifier';
import { isDuplicateKeyOn } from '../../utils/duplicateKey';
import { logger } from '../../utils/logger';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a locker file survives without being played. */
export const UPLOAD_RETENTION_DAYS = 365;
/** How far ahead of expiry the owner is warned. */
export const DELETION_NOTICE_LEAD_DAYS = 14;
/** How long the bytes survive the soft delete before they are really gone. */
export const HARD_DELETE_GRACE_DAYS = 30;

/** Documents touched per phase per tick, so one sweep cannot run unbounded. */
const SWEEP_BATCH_SIZE = 500;

/** How often the tick fires on each instance. */
const TICK_INTERVAL_MS = 60 * 60 * 1000;
/** First tick is delayed so it never competes with cold-start boot work. */
const INITIAL_DELAY_MS = 5 * 60 * 1000;
/** Lock lease; must comfortably exceed a worst-case sweep. */
const SWEEP_LOCK_TTL_MS = 15 * 60 * 1000;

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
  const result = await UserUploadModel.updateOne(
    { _id: uploadId, ownerOxyUserId, deletedAt: null },
    {
      $set: {
        lastPlayedAt: now,
        expiresAt: new Date(now.getTime() + UPLOAD_RETENTION_DAYS * DAY_MS),
      },
      $inc: { playCount: 1 },
      $unset: { deletionNoticeSentAt: '' },
    },
  );

  return result.matchedCount > 0;
}

// ── Lock ─────────────────────────────────────────────────────────────────────

/** `Document<string>` because the lock's `_id` IS its name — there is exactly one row. */
interface ISweepLock extends Document<string> {
  _id: string;
  lockedUntil: Date;
  holder: string;
}

const SweepLockSchema = new Schema<ISweepLock>({
  _id: { type: String, required: true },
  lockedUntil: { type: Date, required: true },
  holder: { type: String, required: true },
}, { versionKey: false });

const SweepLockModel: mongoose.Model<ISweepLock> =
  (mongoose.models.UploadSweepLock as mongoose.Model<ISweepLock>) ??
  mongoose.model<ISweepLock>('UploadSweepLock', SweepLockSchema, 'uploadsweeplocks');

const SWEEP_LOCK_ID = 'uploads:expiry';

/**
 * Claim the sweep for this instance, or report that somebody else holds it.
 *
 * The upsert IS the decision. A read-then-write leaves exactly the window where
 * two tasks both see a free lock; here the second one's upsert collides on `_id`
 * and Mongo answers `E11000`, which is the expected non-exceptional path rather
 * than an error. A held lock also expires on its own, so a task that dies mid-
 * sweep never wedges the job permanently.
 */
async function acquireSweepLock(now: Date, holder: string): Promise<boolean> {
  try {
    await SweepLockModel.findOneAndUpdate(
      { _id: SWEEP_LOCK_ID, lockedUntil: { $lte: now } },
      { $set: { lockedUntil: new Date(now.getTime() + SWEEP_LOCK_TTL_MS), holder } },
      { upsert: true },
    );
    return true;
  } catch (err) {
    // Losing the race on `_id` IS the answer — somebody else holds the sweep.
    // Named rather than a bare 11000 check: a collision on any OTHER index would
    // be a bug, and reporting it as "another instance has it" would skip the
    // sweep forever without ever surfacing why.
    if (isDuplicateKeyOn(err, '_id')) return false;
    throw err;
  }
}

async function releaseSweepLock(holder: string): Promise<void> {
  // Only the holder releases: a lease that already expired may belong to another
  // task by now, and clearing it would let a third one in alongside it.
  await SweepLockModel.updateOne(
    { _id: SWEEP_LOCK_ID, holder },
    { $set: { lockedUntil: new Date(0) } },
  );
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

  const due = await UserUploadModel.find({
    deletedAt: null,
    deletionNoticeSentAt: { $exists: false },
    expiresAt: { $gt: now, $lte: noticeHorizon },
  })
    .sort({ expiresAt: 1 })
    .limit(SWEEP_BATCH_SIZE)
    .select('_id ownerOxyUserId expiresAt')
    .lean();

  if (due.length === 0) return { ownersNotified: 0, uploadsNoticed: 0 };

  const byOwner = new Map<string, { ids: string[]; earliest: Date }>();
  for (const upload of due) {
    if (!upload.expiresAt) continue;
    const entry = byOwner.get(upload.ownerOxyUserId);
    if (entry) {
      entry.ids.push(upload._id.toString());
      if (upload.expiresAt < entry.earliest) entry.earliest = upload.expiresAt;
    } else {
      byOwner.set(upload.ownerOxyUserId, {
        ids: [upload._id.toString()],
        earliest: upload.expiresAt,
      });
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
    const { modifiedCount } = await UserUploadModel.updateMany(
      { _id: { $in: ids } },
      { $set: { deletionNoticeSentAt: now } },
    );
    uploadsNoticed += modifiedCount;
  }

  return { ownersNotified: byOwner.size, uploadsNoticed };
}

/** Phase 2 — hide expired files. Bytes stay; only the document is stamped. */
async function sweepSoftDeletes(now: Date): Promise<number> {
  const expired = await UserUploadModel.find({
    deletedAt: null,
    expiresAt: { $lte: now },
  })
    .limit(SWEEP_BATCH_SIZE)
    .select('_id')
    .lean();

  if (expired.length === 0) return 0;

  const { modifiedCount } = await UserUploadModel.updateMany(
    { _id: { $in: expired.map((upload) => upload._id) } },
    { $set: { deletedAt: now } },
  );
  return modifiedCount;
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
   * A projection, not a hydrated document, and never `fingerprint`.
   *
   * These rows are loaded only to be deleted, and the delete helper takes a
   * structural storage ref. A locker fingerprint is thousands of int32s per row
   * and the sweep walks up to `SWEEP_BATCH_SIZE` of them per tick — pulling that
   * across the wire to read three key fields is the whole batch's cost.
   */
  const doomed = await UserUploadModel.find({
    deletedAt: { $lte: graceCutoff },
  })
    .limit(SWEEP_BATCH_SIZE)
    .select('_id audioSource hls hlsMasterKey')
    .lean();

  let uploadsHardDeleted = 0;
  let objectsDeleted = 0;

  for (const upload of doomed) {
    try {
      objectsDeleted += await deleteObjects(upload);
    } catch (err) {
      // Keep the document: it is the only remaining record of which objects still
      // need deleting. The next tick tries again.
      logger.error('[uploads] failed to delete stored objects for expired upload', {
        uploadId: upload._id.toString(),
        err,
      });
      continue;
    }

    await UserUploadModel.deleteOne({ _id: upload._id });
    uploadsHardDeleted += 1;
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

  const holder = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  if (!(await acquireSweepLock(now, holder))) {
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
    await releaseSweepLock(holder);
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
    logger.error('[uploads] expiry sweep failed', { err });
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
