import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../../test/mongo';
import { UserUploadModel } from '../../models/UserUpload';
import { deleteUploadStoredObjects, type UploadStorageRef } from '../compliance/takedown';
import { getS3LockerAudioKey, getS3LockerHlsKey, getS3LockerHlsPrefix } from '../../config/s3.config';
import {
  computeUploadExpiry,
  recordUploadPlay,
  runExpirySweep,
  DELETION_NOTICE_LEAD_DAYS,
  HARD_DELETE_GRACE_DAYS,
  UPLOAD_RETENTION_DAYS,
  type ExpiryNoticeInput,
} from './expirySweeper';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const DAY_MS = 24 * 60 * 60 * 1000;

/** A fixed "now" so every assertion below is arithmetic, not wall-clock luck. */
const T0 = new Date('2026-08-01T12:00:00.000Z');
const at = (offsetDays: number): Date => new Date(T0.getTime() + offsetDays * DAY_MS);

let shaCounter = 0;

async function seedUpload(overrides: Record<string, unknown> = {}) {
  shaCounter += 1;
  return UserUploadModel.create({
    ownerOxyUserId: 'oxy-owner',
    title: 'Some Recording',
    duration: 210,
    sizeBytes: 5_242_880,
    sha256: shaCounter.toString(16).padStart(64, '0'),
    status: 'ready',
    audioSource: { key: 'locker/oxy-owner/x/source.mp3', format: 'mp3' },
    ...overrides,
  });
}

/** Records what the sweeper asked to delete, so a test can assert on the keys. */
function recordingDeleter() {
  const deleted: string[] = [];
  return {
    deleted,
    deleteObjects: async (upload: UploadStorageRef): Promise<number> => {
      deleted.push(upload._id.toString());
      return 1;
    },
  };
}

function recordingNotifier() {
  const notices: ExpiryNoticeInput[] = [];
  return {
    notices,
    notify: async (input: ExpiryNoticeInput): Promise<void> => {
      notices.push(input);
    },
  };
}

/**
 * Every sweep in this file injects BOTH side-effect deps.
 *
 * Not tidiness: the defaults reach S3 and the Oxy notification API, and a test
 * that silently fell through to them would either fail for the wrong reason or —
 * worse — pass while proving nothing about the schedule.
 */
function sweepAt(
  now: Date,
  deps: {
    notify?: (input: ExpiryNoticeInput) => Promise<void>;
    deleteObjects?: (upload: UploadStorageRef) => Promise<number>;
  } = {},
) {
  return runExpirySweep({
    now: () => now,
    notify: deps.notify ?? (async () => undefined),
    deleteObjects: deps.deleteObjects ?? (async () => 0),
  });
}

// ── Expiry arithmetic ────────────────────────────────────────────────────────

describe('computeUploadExpiry', () => {
  it('gives an unplayed file a full year from upload', () => {
    // `lastPlayedAt` is absent until the first play. Treating that absence as
    // epoch would expire every untouched upload the moment it was stored.
    expect(computeUploadExpiry({ createdAt: T0 }).getTime()).toBe(
      T0.getTime() + UPLOAD_RETENTION_DAYS * DAY_MS,
    );
  });

  it('measures from the last play once there has been one', () => {
    const created = at(-100);
    const played = at(-10);
    expect(computeUploadExpiry({ createdAt: created, lastPlayedAt: played }).getTime()).toBe(
      played.getTime() + UPLOAD_RETENTION_DAYS * DAY_MS,
    );
  });

  it('never moves expiry BACKWARDS for a play older than the upload', () => {
    const created = at(-10);
    const played = at(-100);
    expect(computeUploadExpiry({ createdAt: created, lastPlayedAt: played }).getTime()).toBe(
      created.getTime() + UPLOAD_RETENTION_DAYS * DAY_MS,
    );
  });
});

// ── Play pushes expiry ───────────────────────────────────────────────────────

describe('recordUploadPlay', () => {
  it('pushes expiresAt a full year out and counts the play', async () => {
    const upload = await seedUpload({ expiresAt: at(3) });

    const played = await recordUploadPlay(upload._id.toString(), 'oxy-owner', T0);
    expect(played).toBe(true);

    const after = await UserUploadModel.findById(upload._id).lean();
    expect(after?.expiresAt?.getTime()).toBe(T0.getTime() + UPLOAD_RETENTION_DAYS * DAY_MS);
    expect(after?.lastPlayedAt?.getTime()).toBe(T0.getTime());
    expect(after?.playCount).toBe(1);
  });

  it('clears a notice already sent, so the next window warns again', async () => {
    // A notice is about ONE expiry window. Leaving it set would make the file
    // skip its warning the next time it approaches deletion, a year later.
    const upload = await seedUpload({ expiresAt: at(3), deletionNoticeSentAt: at(-1) });

    await recordUploadPlay(upload._id.toString(), 'oxy-owner', T0);

    const after = await UserUploadModel.findById(upload._id).lean();
    expect(after?.deletionNoticeSentAt).toBeUndefined();
  });

  it('does nothing for a DIFFERENT owner', async () => {
    const upload = await seedUpload({ expiresAt: at(3) });

    const played = await recordUploadPlay(upload._id.toString(), 'oxy-someone-else', T0);
    expect(played).toBe(false);

    const after = await UserUploadModel.findById(upload._id).lean();
    expect(after?.playCount).toBe(0);
    expect(after?.expiresAt?.getTime()).toBe(at(3).getTime());
  });

  it('does nothing for a soft-deleted file', async () => {
    const upload = await seedUpload({ expiresAt: at(-1), deletedAt: at(-1) });

    expect(await recordUploadPlay(upload._id.toString(), 'oxy-owner', T0)).toBe(false);
  });
});

// ── T-14d: notice ────────────────────────────────────────────────────────────

describe('expiry sweep — the T-14d notice', () => {
  it('warns the owner once for all their expiring files, and stamps every one', async () => {
    const soon = await seedUpload({ expiresAt: at(3) });
    const later = await seedUpload({ expiresAt: at(10) });
    const notifier = recordingNotifier();

    const result = await sweepAt(T0, { notify: notifier.notify });

    expect(result.ran).toBe(true);
    // One notice, not one per file: the clear-out that makes the warning worth
    // sending is exactly the one that would otherwise send fifty of them.
    expect(notifier.notices).toHaveLength(1);
    expect(result.ownersNotified).toBe(1);

    const notice = notifier.notices[0];
    expect(notice.ownerOxyUserId).toBe('oxy-owner');
    expect(notice.uploadCount).toBe(2);
    expect(notice.earliestExpiresAt.getTime()).toBe(at(3).getTime());
    expect(new Set(notice.uploadIds)).toEqual(
      new Set([soon._id.toString(), later._id.toString()]),
    );

    expect(result.uploadsNoticed).toBe(2);
    const stamped = await UserUploadModel.find({ deletionNoticeSentAt: { $exists: true } }).lean();
    expect(stamped).toHaveLength(2);
  });

  it('sends one notice per OWNER, not one for the batch', async () => {
    await seedUpload({ expiresAt: at(3) });
    await seedUpload({ ownerOxyUserId: 'oxy-other', expiresAt: at(5) });
    const notifier = recordingNotifier();

    const result = await sweepAt(T0, { notify: notifier.notify });

    expect(result.ownersNotified).toBe(2);
    expect(new Set(notifier.notices.map((notice) => notice.ownerOxyUserId))).toEqual(
      new Set(['oxy-owner', 'oxy-other']),
    );
  });

  it('says nothing about a file outside the notice window', async () => {
    await seedUpload({ expiresAt: at(DELETION_NOTICE_LEAD_DAYS + 1) });
    const notifier = recordingNotifier();

    const result = await sweepAt(T0, { notify: notifier.notify });

    expect(notifier.notices).toHaveLength(0);
    expect(result.uploadsNoticed).toBe(0);
  });

  it('does not warn the same file twice', async () => {
    await seedUpload({ expiresAt: at(3), deletionNoticeSentAt: at(-1) });
    const notifier = recordingNotifier();

    const result = await sweepAt(T0, { notify: notifier.notify });

    expect(notifier.notices).toHaveLength(0);
    expect(result.uploadsNoticed).toBe(0);
  });

  it('stops warning a file that was played back into safety', async () => {
    const upload = await seedUpload({ expiresAt: at(3) });

    await recordUploadPlay(upload._id.toString(), 'oxy-owner', T0);

    const notifier = recordingNotifier();
    const result = await sweepAt(T0, { notify: notifier.notify });

    expect(notifier.notices).toHaveLength(0);
    expect(result.uploadsSoftDeleted).toBe(0);
  });
});

// ── T0: soft delete ──────────────────────────────────────────────────────────

describe('expiry sweep — T0 soft delete', () => {
  it('hides an expired file and KEEPS its bytes', async () => {
    const upload = await seedUpload({ expiresAt: at(-1), deletionNoticeSentAt: at(-15) });
    const deleter = recordingDeleter();

    const result = await sweepAt(T0, { deleteObjects: deleter.deleteObjects });

    expect(result.uploadsSoftDeleted).toBe(1);

    const after = await UserUploadModel.findById(upload._id).lean();
    expect(after).not.toBeNull();
    expect(after?.deletedAt?.getTime()).toBe(T0.getTime());

    // The grace period is the whole point of a soft delete: nothing in storage
    // may be touched until it has run out.
    expect(deleter.deleted).toEqual([]);
    expect(result.objectsDeleted).toBe(0);
  });

  it('leaves a file that has not expired alone', async () => {
    const upload = await seedUpload({ expiresAt: at(1) });

    const result = await sweepAt(T0);

    expect(result.uploadsSoftDeleted).toBe(0);
    const after = await UserUploadModel.findById(upload._id).lean();
    expect(after?.deletedAt).toBeUndefined();
  });
});

// ── T+30d: hard delete ───────────────────────────────────────────────────────

describe('expiry sweep — T+30d hard delete', () => {
  it('deletes the stored objects AND the document', async () => {
    const upload = await seedUpload({
      expiresAt: at(-HARD_DELETE_GRACE_DAYS - 1),
      deletedAt: at(-HARD_DELETE_GRACE_DAYS - 1),
    });
    const deleter = recordingDeleter();

    const result = await sweepAt(T0, { deleteObjects: deleter.deleteObjects });

    expect(deleter.deleted).toEqual([upload._id.toString()]);
    expect(result.uploadsHardDeleted).toBe(1);
    expect(result.objectsDeleted).toBe(1);
    expect(await UserUploadModel.findById(upload._id).lean()).toBeNull();
  });

  it('waits out the full grace period', async () => {
    const upload = await seedUpload({
      expiresAt: at(-HARD_DELETE_GRACE_DAYS + 1),
      deletedAt: at(-HARD_DELETE_GRACE_DAYS + 1),
    });
    const deleter = recordingDeleter();

    const result = await sweepAt(T0, { deleteObjects: deleter.deleteObjects });

    expect(deleter.deleted).toEqual([]);
    expect(result.uploadsHardDeleted).toBe(0);
    expect(await UserUploadModel.findById(upload._id).lean()).not.toBeNull();
  });

  it('removes BOTH the source object and the whole HLS prefix', async () => {
    /**
     * Run through the REAL `deleteUploadStoredObjects` with only S3 injected,
     * rather than a stand-in that counts calls.
     *
     * A hard delete that drops the document and the source object but leaves the
     * HLS segments behind is invisible from the outside — no error, no orphan
     * report, just storage nobody will ever name again. The only way to catch it
     * is to assert on the KEYS the purge asks for, through the code that composes
     * them.
     */
    const ownerOxyUserId = 'oxy-owner';
    const uploadId = new mongoose.Types.ObjectId();
    const audioKey = getS3LockerAudioKey(ownerOxyUserId, uploadId.toString(), 'mp3');

    await UserUploadModel.create({
      _id: uploadId,
      ownerOxyUserId,
      title: 'Expired',
      duration: 210,
      sizeBytes: 1024,
      sha256: 'e'.repeat(64),
      status: 'ready',
      audioSource: { key: audioKey, format: 'mp3' },
      hlsMasterKey: getS3LockerHlsKey(ownerOxyUserId, uploadId.toString(), 'master.m3u8'),
      hls: [
        {
          manifestKey: getS3LockerHlsKey(ownerOxyUserId, uploadId.toString(), '160/index.m3u8'),
          bitrateKbps: 160,
          encrypted: true,
        },
      ],
      expiresAt: at(-HARD_DELETE_GRACE_DAYS - 1),
      deletedAt: at(-HARD_DELETE_GRACE_DAYS - 1),
    });

    const objectDeletes: string[] = [];
    const prefixDeletes: string[] = [];

    const result = await sweepAt(T0, {
      deleteObjects: (upload) =>
        deleteUploadStoredObjects(upload, {
          deleteObject: async (key) => { objectDeletes.push(key); },
          deletePrefix: async (prefix) => { prefixDeletes.push(prefix); return 3; },
        }),
    });

    // The segments live under the upload's own directory, and only a PREFIX
    // delete reaches them: the document records the manifests, never the `.ts`
    // files beside them.
    expect(prefixDeletes).toEqual([getS3LockerHlsPrefix(ownerOxyUserId, uploadId.toString())]);
    // The source object sits outside that directory, so it needs its own delete.
    expect(objectDeletes).toContain(audioKey);
    // ...and is NOT swept twice by the prefix, which would double-count.
    expect(audioKey.startsWith(getS3LockerHlsPrefix(ownerOxyUserId, uploadId.toString()))).toBe(false);

    expect(result.uploadsHardDeleted).toBe(1);
    expect(await UserUploadModel.findById(uploadId).lean()).toBeNull();
  });

  it('does NOT mistake the source key for a directory and empty the whole locker', async () => {
    /**
     * `uploads/{owner}/{uploadId}.mp3` has the owner's directory as its parent.
     * Taking that parent as a prefix would delete every other file this listener
     * owns. The guard is that a swept prefix must contain the upload's id as a
     * path SEGMENT — which the source key, where the id is the filename, does not.
     */
    const ownerOxyUserId = 'oxy-owner';
    const uploadId = new mongoose.Types.ObjectId();

    await UserUploadModel.create({
      _id: uploadId,
      ownerOxyUserId,
      title: 'Never transcoded',
      duration: 210,
      sizeBytes: 1024,
      sha256: 'd'.repeat(64),
      status: 'failed',
      audioSource: {
        key: getS3LockerAudioKey(ownerOxyUserId, uploadId.toString(), 'mp3'),
        format: 'mp3',
      },
      expiresAt: at(-HARD_DELETE_GRACE_DAYS - 1),
      deletedAt: at(-HARD_DELETE_GRACE_DAYS - 1),
    });

    const prefixDeletes: string[] = [];
    await sweepAt(T0, {
      deleteObjects: (upload) =>
        deleteUploadStoredObjects(upload, {
          deleteObject: async () => undefined,
          deletePrefix: async (prefix) => { prefixDeletes.push(prefix); return 1; },
        }),
    });

    expect(prefixDeletes).toEqual([]);
  });

  it('KEEPS the document when its objects could not be deleted', async () => {
    // The row is the only remaining record of which objects still need deleting.
    // Removing it after a storage failure would leave audio in the bucket that
    // nothing will ever name again — the exact failure the ordering exists to
    // prevent.
    const upload = await seedUpload({
      expiresAt: at(-HARD_DELETE_GRACE_DAYS - 1),
      deletedAt: at(-HARD_DELETE_GRACE_DAYS - 1),
    });

    const result = await sweepAt(T0, {
      deleteObjects: async () => {
        throw new Error('S3 is having a day');
      },
    });

    expect(result.uploadsHardDeleted).toBe(0);
    expect(await UserUploadModel.findById(upload._id).lean()).not.toBeNull();
  });
});

// ── The whole schedule, on one file ──────────────────────────────────────────

describe('expiry sweep — the full schedule', () => {
  it('walks one file from notice to soft delete to hard delete', async () => {
    const expiresAt = at(0);
    const upload = await seedUpload({ expiresAt });
    const notifier = recordingNotifier();
    const deleter = recordingDeleter();
    const deps = { notify: notifier.notify, deleteObjects: deleter.deleteObjects };

    // T-20d — outside the window; nothing happens.
    await sweepAt(at(-20), deps);
    expect(notifier.notices).toHaveLength(0);

    // T-14d — the warning.
    await sweepAt(at(-DELETION_NOTICE_LEAD_DAYS), deps);
    expect(notifier.notices).toHaveLength(1);
    expect((await UserUploadModel.findById(upload._id).lean())?.deletedAt).toBeUndefined();

    // T0 — hidden, bytes retained.
    await sweepAt(at(0), deps);
    expect((await UserUploadModel.findById(upload._id).lean())?.deletedAt).toBeDefined();
    expect(deleter.deleted).toEqual([]);

    // T+29d — still inside the grace period.
    await sweepAt(at(HARD_DELETE_GRACE_DAYS - 1), deps);
    expect(await UserUploadModel.findById(upload._id).lean()).not.toBeNull();

    // T+30d — gone, storage first.
    await sweepAt(at(HARD_DELETE_GRACE_DAYS), deps);
    expect(deleter.deleted).toEqual([upload._id.toString()]);
    expect(await UserUploadModel.findById(upload._id).lean()).toBeNull();
  });
});

// ── The fleet lock ───────────────────────────────────────────────────────────

describe('expiry sweep — the fleet lock', () => {
  it('lets exactly one concurrent sweep through', async () => {
    await seedUpload({ expiresAt: at(-1) });

    const [first, second] = await Promise.all([sweepAt(T0), sweepAt(T0)]);

    // Whichever won, exactly one ran and exactly one file was swept once.
    expect([first.ran, second.ran].filter(Boolean)).toHaveLength(1);
    expect(first.uploadsSoftDeleted + second.uploadsSoftDeleted).toBe(1);
  });

  it('releases the lock so the next tick can run', async () => {
    await seedUpload({ expiresAt: at(-1) });

    expect((await sweepAt(T0)).ran).toBe(true);
    expect((await sweepAt(T0)).ran).toBe(true);
  });
});
