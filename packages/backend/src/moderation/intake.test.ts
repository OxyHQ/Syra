import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import { ReportModel, ReportCategory, ReportedType } from '../models/Report';
import { ModerationOutboxModel } from '../models/ModerationOutbox';
import { createReport, DuplicateReportError } from './intake';
import {
  ModerationOutboxTransactionError,
  enqueueModerationOutboxEvent,
  reportSubmitEventId,
} from './outbox';

/**
 * The intake coupling, against a REAL transaction.
 *
 * These run on a single-member replica set rather than a standalone precisely so
 * the transaction is real: a mocked session proves the code calls
 * `withTransaction`, but only a real one proves the two writes actually commit
 * together and roll back together. That is the whole guarantee.
 */

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const REPORTER = 'oxy-user-1';

async function makePlaylist(): Promise<string> {
  const id = new mongoose.Types.ObjectId();
  return id.toHexString();
}

describe('createReport', () => {
  describe('the report and its delivery event commit together', () => {
    it('stores both for a type with a subject provider', async () => {
      const playlistId = await makePlaylist();
      const result = await createReport({
        reporter: REPORTER,
        reportedType: ReportedType.PLAYLIST,
        reportedId: playlistId,
        categories: [ReportCategory.SPAM],
      });

      const stored = await ReportModel.findById(result.report._id).lean();
      expect(stored?.localStatus).toBe('queued');
      expect(stored?.localStatusReason).toBeUndefined();

      const event = await ModerationOutboxModel.findById(
        reportSubmitEventId(result.report._id.toHexString()),
      ).lean();
      expect(event).not.toBeNull();
      expect(event?.kind).toBe('report.submit');
      expect(event?.payload?.reportId).toBe(result.report._id.toHexString());
      expect(event?.status).toBe('pending');
    });

    /**
     * A type with no provider is STORED, not refused, and gets no outbox row at
     * all — never one a worker skips later, which would dead-letter a report that
     * is not defective. "There was never a route out of this application for this
     * kind of object" is a different claim from "delivery failed".
     */
    it('stores a type with no provider and enqueues nothing', async () => {
      const result = await createReport({
        reporter: REPORTER,
        reportedType: ReportedType.PODCAST,
        reportedId: 'external-show-1',
        categories: [ReportCategory.SPAM],
      });

      expect(result.outboxEventId).toBeUndefined();
      const stored = await ReportModel.findById(result.report._id).lean();
      expect(stored?.localStatus).toBe('received');
      expect(stored?.localStatusReason).toContain('no moderation subject provider');
      expect(await ModerationOutboxModel.countDocuments({})).toBe(0);
    });

    it('accepts a listener report and keeps it local too', async () => {
      const result = await createReport({
        reporter: REPORTER,
        reportedType: ReportedType.USER,
        reportedId: 'oxy-user-2',
        categories: [ReportCategory.HARASSMENT],
      });
      expect(result.outboxEventId).toBeUndefined();
      expect(await ModerationOutboxModel.countDocuments({})).toBe(0);
    });

    /**
     * The rollback half, which a mocked session cannot show. If anything after the
     * report write throws, the report must not survive either — a committed report
     * with no delivery event is the silent failure this design exists to prevent.
     */
    it('rolls the report back when the outbox write fails', async () => {
      const playlistId = await makePlaylist();
      const eventId = reportSubmitEventId('unused');
      // Occupy the outbox id space with a document whose shape violates the
      // schema on update, forcing the second write to throw inside the
      // transaction. A duplicate `_id` upsert is the closest real-world analogue.
      const original = ModerationOutboxModel.updateOne.bind(ModerationOutboxModel);
      let threw = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ModerationOutboxModel as any).updateOne = async () => {
        threw = true;
        throw new Error('simulated outbox failure');
      };
      try {
        await expect(
          createReport({
            reporter: REPORTER,
            reportedType: ReportedType.PLAYLIST,
            reportedId: playlistId,
            categories: [ReportCategory.SPAM],
          }),
        ).rejects.toThrow('simulated outbox failure');
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ModerationOutboxModel as any).updateOne = original;
      }

      expect(threw).toBe(true);
      void eventId;
      // The report must be gone. If this ever finds a row, a user was told 201
      // for a report nothing will ever deliver.
      expect(await ReportModel.countDocuments({})).toBe(0);
    });
  });

  describe('identifier guards', () => {
    /**
     * A type is erased at runtime and a truthiness check passes `{$ne: null}`.
     * Handed that, `findOne` matches an UNRELATED report and the caller is told
     * "you already reported this" about somebody else's row.
     */
    it('refuses a query operator smuggled in as an identifier', async () => {
      await expect(
        createReport({
          reporter: { $ne: null },
          reportedType: ReportedType.PLAYLIST,
          reportedId: 'x',
          categories: [ReportCategory.SPAM],
        } as never),
      ).rejects.toBeInstanceOf(TypeError);
      expect(await ReportModel.countDocuments({})).toBe(0);
    });

    it('refuses an unknown reported type', async () => {
      await expect(
        createReport({
          reporter: REPORTER,
          reportedType: 'not_a_type' as ReportedType,
          reportedId: 'x',
          categories: [ReportCategory.SPAM],
        }),
      ).rejects.toBeInstanceOf(TypeError);
    });

    it('refuses a report with no category', async () => {
      await expect(
        createReport({
          reporter: REPORTER,
          reportedType: ReportedType.PLAYLIST,
          reportedId: 'x',
          categories: [],
        }),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });

  it('refuses a second report of the same object by the same reporter', async () => {
    const playlistId = await makePlaylist();
    const input = {
      reporter: REPORTER,
      reportedType: ReportedType.PLAYLIST,
      reportedId: playlistId,
      categories: [ReportCategory.SPAM],
    };
    await createReport(input);
    await expect(createReport(input)).rejects.toBeInstanceOf(DuplicateReportError);
    expect(await ReportModel.countDocuments({})).toBe(1);
  });
});

describe('enqueueModerationOutboxEvent', () => {
  /**
   * THE invariant. Nothing may be enqueued that is not already recorded in the
   * same transaction as the domain write.
   *
   * The type already makes the session mandatory. This runtime check is what makes
   * it mandatory that a transaction is actually OPEN — a bare `startSession()`
   * satisfies the parameter, type-checks perfectly, and commits the row on its
   * own.
   */
  it('refuses to write outside a transaction, and writes nothing when it refuses', async () => {
    const session = await mongoose.startSession();
    try {
      await expect(
        enqueueModerationOutboxEvent(
          { eventId: 'moderation:report.submit:x', kind: 'report.submit', payload: {} },
          session,
        ),
      ).rejects.toBeInstanceOf(ModerationOutboxTransactionError);
    } finally {
      await session.endSession();
    }
    expect(await ModerationOutboxModel.countDocuments({})).toBe(0);
  });

  it('says why in terms of the consequence rather than the rule', async () => {
    const session = await mongoose.startSession();
    try {
      await expect(
        enqueueModerationOutboxEvent(
          { eventId: 'moderation:report.submit:x', kind: 'report.submit', payload: {} },
          session,
        ),
      ).rejects.toThrow(/answered 201 and never delivered/);
    } finally {
      await session.endSession();
    }
  });

  /**
   * Derived from the domain object, never generated: a transaction retry or two
   * concurrent duplicate submissions upsert the SAME row rather than queueing two
   * deliveries.
   */
  it('upserts the same row when called twice for one report', async () => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await enqueueModerationOutboxEvent(
          { eventId: reportSubmitEventId('r1'), kind: 'report.submit', payload: { reportId: 'r1' } },
          session,
        );
        await enqueueModerationOutboxEvent(
          { eventId: reportSubmitEventId('r1'), kind: 'report.submit', payload: { reportId: 'r1' } },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    expect(await ModerationOutboxModel.countDocuments({})).toBe(1);
  });
});
