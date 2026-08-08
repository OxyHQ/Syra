import { Response, NextFunction } from 'express';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { isLiveEntityId } from '@oxyhq/db';
import { z } from 'zod';
import { getDb, isPostgresConnected } from '../db/postgres';
import { tracks } from '../db/schema/catalog';
import { copyrightReports } from '../db/schema/creators';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { getParam, parseBoundedLimit, parseOffset } from '../utils/reqParams';
import { takeDownTrack, type TakeDownTrackResult } from '../services/compliance/takedown';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

/**
 * Ported here rather than deferred with the rest of Task 13's vertical, and the
 * reason is structural: `tracks.copyright_report_id` really
 * `.references(() => copyrightReports.id)`. A hybrid split survives a
 * cross-vertical READ and cannot survive a cross-vertical FOREIGN KEY — leaving
 * this table on Mongoose while `takeDownTrack` is drizzle means the takedown
 * writes a Mongo `_id` into a column constrained against `copyright_reports`,
 * and Postgres refuses it with `23503`.
 */

/**
 * POST /api/copyright/report
 * Public endpoint to report copyright violation (no authentication required)
 */
export const reportCopyrightViolation = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { trackId, reason } = req.body;

    if (!trackId || !reason || !reason.trim()) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'trackId and reason are required'
      });
    }

    // Both live id shapes — `tracks.id` is a uuid v7 since the cutover.
    if (!isLiveEntityId(trackId)) {
      return res.status(400).json({ error: 'Invalid trackId format' });
    }

    // Verify track exists
    const [track] = await getDb()
      .select({ artistId: tracks.artistId })
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .limit(1);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // Check if already reported (pending or approved). Served by
    // `copyright_reports_track_id_status_idx`.
    const [existingReport] = await getDb()
      .select({ id: copyrightReports.id })
      .from(copyrightReports)
      .where(
        and(
          eq(copyrightReports.trackId, trackId),
          inArray(copyrightReports.status, ['pending', 'approved'])
        )
      )
      .limit(1);

    if (existingReport) {
      return res.status(400).json({
        error: 'Already reported',
        message: 'This track has already been reported for copyright violation'
      });
    }

    const reporterOxyUserId = req.user?.id;

    const [report] = await getDb()
      .insert(copyrightReports)
      .values({
        trackId,
        artistId: track.artistId,
        reporterOxyUserId,
        reason: reason.trim(),
        status: 'pending',
      })
      .returning({ id: copyrightReports.id });

    if (!report) throw new Error('reportCopyrightViolation: insert returned no row');

    logger.info(`[CopyrightController] Copyright report created for track ${trackId} by ${reporterOxyUserId || 'anonymous'}`);

    res.status(201).json({
      id: report.id,
      trackId,
      status: 'pending',
      message: 'Copyright violation report submitted successfully',
    });
  } catch (error) {
    logger.error('[CopyrightController] Error reporting copyright violation:', { error: describeErrorSafely(error) });
    next(error);
  }
};

// ── Review ────────────────────────────────────────────────────────────────────

/**
 * The reviewer's decision.
 *
 * Backend-only, so it lives here rather than in `@syra/shared-types`: no client
 * ships a copyright review screen, and a contract in the shared package is a
 * contract some app can be written against. `pending` is deliberately absent —
 * this endpoint exists to END a review, and accepting `pending` would let a
 * resolution be silently undone.
 */
const resolveCopyrightReportSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  resolutionNote: z.string().max(2000).optional(),
});

/** Which slice of the queue to read. Defaults to what a reviewer opens it for. */
const copyrightReportStatusSchema = z.enum(['pending', 'approved', 'rejected']);

type CopyrightReportRow = typeof copyrightReports.$inferSelect;

/**
 * An explicit allowlist, exactly as it was: every key is named, nothing is
 * spread. `updated_at` is a column here and was not a field on the Mongo
 * document, so it stays off the wire by simply not being written down.
 *
 * `reporterOxyUserId` IS on it, deliberately and unchanged — this response is
 * reachable only behind `requireComplianceReviewer`, and knowing who filed a
 * DMCA notice is the reviewer's job.
 */
function serializeReport(report: CopyrightReportRow) {
  return {
    id: report.id,
    trackId: report.trackId,
    artistId: report.artistId,
    reporterOxyUserId: report.reporterOxyUserId ?? undefined,
    reason: report.reason,
    status: report.status,
    createdAt: report.createdAt.toISOString(),
    resolvedAt: report.resolvedAt?.toISOString(),
    resolvedBy: report.resolvedBy ?? undefined,
  };
}

/**
 * GET /api/copyright/reports — the review queue (reviewers only).
 *
 * Oldest pending first, because a report waiting is a work still being
 * distributed. Served by the existing `{ status, createdAt }` index.
 */
export const listCopyrightReports = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const statusFilter = copyrightReportStatusSchema.safeParse(req.query.status ?? 'pending');
    if (!statusFilter.success) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }
    const status = statusFilter.data;

    const limit = parseBoundedLimit(req.query.limit, 50);
    const offset = parseOffset(req.query.offset);

    const [reports, [totals]] = await Promise.all([
      getDb()
        .select()
        .from(copyrightReports)
        .where(eq(copyrightReports.status, status))
        .orderBy(asc(copyrightReports.createdAt))
        .offset(offset)
        .limit(limit),
      getDb()
        .select({ total: count() })
        .from(copyrightReports)
        .where(eq(copyrightReports.status, status)),
    ]);

    const total = totals?.total ?? 0;

    res.json({
      reports: reports.map(serializeReport),
      total,
      hasMore: offset + reports.length < total,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/copyright/reports/:id/resolve — resolve a report (reviewers only).
 *
 * This is the endpoint the takedown machinery hangs from. Until it existed,
 * `CopyrightReport` rows accumulated and nothing ever read them: no track was
 * ever marked `copyrightRemoved`, `strikeService` had no callers at all, and the
 * repeat-infringer threshold could not be reached however many reports arrived.
 *
 * An APPROVED report is a takedown, and a takedown is irreversible by design —
 * it removes the work from the catalog and from playback, purges every private
 * locker holding the same bytes, and strikes whoever published it. Three of those
 * terminate the account.
 */
export const resolveCopyrightReport = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const reviewerId = getRequiredOxyUserId(req);
    const id = getParam(req, 'id');

    if (!isLiveEntityId(id)) {
      return res.status(400).json({ error: 'Invalid report ID' });
    }

    const parsed = resolveCopyrightReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const [report] = await getDb()
      .select()
      .from(copyrightReports)
      .where(eq(copyrightReports.id, id))
      .limit(1);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    if (report.status !== 'pending') {
      return res.status(409).json({
        error: 'Already resolved',
        message: `This report was already ${report.status}`,
      });
    }

    let takedown: TakeDownTrackResult | null = null;
    if (parsed.data.status === 'approved') {
      takedown = await takeDownTrack({
        trackId: report.trackId,
        reason: parsed.data.resolutionNote?.trim() || `Copyright report: ${report.reason}`,
        actorOxyUserId: reviewerId,
        copyrightReportId: report.id,
      });

      if (!takedown) {
        return res.status(404).json({
          error: 'Track not found',
          message: 'The reported track no longer exists; nothing was taken down',
        });
      }
    }

    const [resolved] = await getDb()
      .update(copyrightReports)
      .set({ status: parsed.data.status, resolvedAt: new Date(), resolvedBy: reviewerId })
      .where(eq(copyrightReports.id, report.id))
      .returning();

    if (!resolved) throw new Error('resolveCopyrightReport: update returned no row');

    logger.info(
      `[CopyrightController] Report ${id} ${parsed.data.status} by ${reviewerId}` +
      (takedown
        ? ` — struck=${takedown.strike.applied} terminated=${takedown.strike.applied && takedown.strike.terminated} ` +
          `lockerFilesPurged=${takedown.purge.uploadsDeleted}`
        : ''),
    );

    res.json({
      report: serializeReport(resolved),
      takedown,
    });
  } catch (error) {
    next(error);
  }
};
