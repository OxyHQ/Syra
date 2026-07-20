import { Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { CopyrightReportModel } from '../models/CopyrightReport';
import { TrackModel } from '../models/Track';
import { isDatabaseConnected } from '../utils/database';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
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
