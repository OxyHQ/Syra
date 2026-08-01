import { Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { CopyrightReportModel, type ICopyrightReport } from '../models/CopyrightReport';
import { TrackModel } from '../models/Track';
import { isDatabaseConnected } from '../utils/database';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { getParam, parseBoundedLimit, parseOffset } from '../utils/reqParams';
import { takeDownTrack, type TakeDownTrackResult } from '../services/compliance/takedown';
import { logger } from '../utils/logger';

/**
 * POST /api/copyright/report
 * Public endpoint to report copyright violation (no authentication required)
 */
export const reportCopyrightViolation = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { trackId, reason } = req.body;

    if (!trackId || !reason || !reason.trim()) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'trackId and reason are required'
      });
    }

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(trackId)) {
      return res.status(400).json({ error: 'Invalid trackId format' });
    }

    // Verify track exists
    const track = await TrackModel.findById(trackId).lean();
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // Check if already reported (pending or approved)
    const existingReport = await CopyrightReportModel.findOne({
      trackId,
      status: { $in: ['pending', 'approved'] },
    }).lean();

    if (existingReport) {
      return res.status(400).json({
        error: 'Already reported',
        message: 'This track has already been reported for copyright violation'
      });
    }

    const reporterOxyUserId = req.user?.id;

    // Create copyright report
    const report = new CopyrightReportModel({
      trackId,
      artistId: track.artistId,
      reporterOxyUserId,
      reason: reason.trim(),
      status: 'pending',
    });

    await report.save();

    logger.info(`[CopyrightController] Copyright report created for track ${trackId} by ${reporterOxyUserId || 'anonymous'}`);

    res.status(201).json({
      id: report._id.toString(),
      trackId,
      status: 'pending',
      message: 'Copyright violation report submitted successfully',
    });
  } catch (error) {
    logger.error('[CopyrightController] Error reporting copyright violation:', error);
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

function serializeReport(report: ICopyrightReport) {
  return {
    id: report._id.toString(),
    trackId: report.trackId,
    artistId: report.artistId,
    reporterOxyUserId: report.reporterOxyUserId,
    reason: report.reason,
    status: report.status,
    createdAt: report.createdAt?.toISOString(),
    resolvedAt: report.resolvedAt?.toISOString(),
    resolvedBy: report.resolvedBy,
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
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const statusFilter = copyrightReportStatusSchema.safeParse(req.query.status ?? 'pending');
    if (!statusFilter.success) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }
    const status = statusFilter.data;

    const limit = parseBoundedLimit(req.query.limit, 50);
    const offset = parseOffset(req.query.offset);

    const [reports, total] = await Promise.all([
      CopyrightReportModel.find({ status })
        .sort({ createdAt: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      CopyrightReportModel.countDocuments({ status }),
    ]);

    res.json({
      reports: reports.map((report) => serializeReport(report as ICopyrightReport)),
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
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const reviewerId = getRequiredOxyUserId(req);
    const id = getParam(req, 'id');

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid report ID' });
    }

    const parsed = resolveCopyrightReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const report = await CopyrightReportModel.findById(id);
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
        copyrightReportId: report._id.toString(),
      });

      if (!takedown) {
        return res.status(404).json({
          error: 'Track not found',
          message: 'The reported track no longer exists; nothing was taken down',
        });
      }
    }

    report.status = parsed.data.status;
    report.resolvedAt = new Date();
    report.resolvedBy = reviewerId;
    await report.save();

    logger.info(
      `[CopyrightController] Report ${id} ${parsed.data.status} by ${reviewerId}` +
      (takedown
        ? ` — struck=${takedown.strike.applied} terminated=${takedown.strike.applied && takedown.strike.terminated} ` +
          `lockerFilesPurged=${takedown.purge.uploadsDeleted}`
        : ''),
    );

    res.json({
      report: serializeReport(report),
      takedown,
    });
  } catch (error) {
    next(error);
  }
};
