import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { CopyrightReportModel } from '../models/CopyrightReport';
import { TrackModel } from '../models/Track';
import { ArtistModel } from '../models/CatalogEntity';
import { isDatabaseConnected } from '../utils/database';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId as getAuthenticatedUserId } from '@oxyhq/core/server';
import { addStrike } from '../services/strikeService';
import { logger } from '../utils/logger';
import { getParam } from '../utils/reqParams';

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

/**
 * GET /api/copyright/reports
 * Admin endpoint to list copyright reports
 */
export const getCopyrightReports = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    // Requires admin role — enforce once the admin system is implemented.
    // For now, require authentication
    const userId = getAuthenticatedUserId(req);

    const status = req.query.status as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const query: any = {};
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      query.status = status;
    }

    const [reports, total] = await Promise.all([
      CopyrightReportModel.find(query)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      CopyrightReportModel.countDocuments(query),
    ]);

    // Populate track and artist info
    const reportsWithDetails = await Promise.all(
      reports.map(async (report) => {
        const track = await TrackModel.findById(report.trackId).lean();
        const artist = await ArtistModel.findById(report.artistId).lean();
        
        return {
          id: report._id.toString(),
          trackId: report.trackId,
          trackTitle: track?.title || 'Unknown',
          artistId: report.artistId,
          artistName: artist?.name || 'Unknown',
          reporterOxyUserId: report.reporterOxyUserId,
          reason: report.reason,
          status: report.status,
          createdAt: report.createdAt,
          resolvedAt: report.resolvedAt,
          resolvedBy: report.resolvedBy,
        };
      })
    );

    res.json({
      reports: reportsWithDetails,
      total,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    logger.error('[CopyrightController] Error fetching copyright reports:', error);
    next(error);
  }
};

/**
 * POST /api/copyright/reports/:id/approve
 * Admin approve copyright report and remove track
 */
export const approveCopyrightReport = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    // Requires admin role — enforce once the admin system is implemented.
    const adminUserId = getAuthenticatedUserId(req);

    const id = getParam(req, 'id');

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid report ID format' });
    }

    const report = await CopyrightReportModel.findById(id).lean();
    if (!report) {
      return res.status(404).json({ error: 'Copyright report not found' });
    }

    if (report.status !== 'pending') {
      return res.status(400).json({ 
        error: 'Invalid status', 
        message: 'Report has already been processed' 
      });
    }

    // Get track
    const track = await TrackModel.findById(report.trackId);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // Mark track as copyright removed
    track.copyrightRemoved = true;
    track.removedAt = new Date();
    track.removedReason = report.reason;
    track.removedBy = report.reporterOxyUserId || adminUserId;
    track.copyrightReportId = report._id.toString();
    track.isAvailable = false; // Make track unavailable for playback

    await track.save();

    // Add strike to artist
    await addStrike(report.artistId, `Copyright violation: ${report.reason}`, report.trackId);

    // Update report status
    await CopyrightReportModel.updateOne(
      { _id: id },
      {
        status: 'approved',
        resolvedAt: new Date(),
        resolvedBy: adminUserId,
      }
    );

    logger.info(`[CopyrightController] Copyright report ${id} approved. Track ${report.trackId} removed.`);

    res.json({
      message: 'Copyright report approved and track removed',
      trackId: report.trackId,
      artistId: report.artistId,
    });
  } catch (error) {
    logger.error('[CopyrightController] Error approving copyright report:', error);
    next(error);
  }
};

/**
 * POST /api/copyright/reports/:id/reject
 * Admin reject copyright report
 */
export const rejectCopyrightReport = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    // Requires admin role — enforce once the admin system is implemented.
    const adminUserId = getAuthenticatedUserId(req);

    const id = getParam(req, 'id');

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid report ID format' });
    }

    const report = await CopyrightReportModel.findById(id).lean();
    if (!report) {
      return res.status(404).json({ error: 'Copyright report not found' });
    }

    if (report.status !== 'pending') {
      return res.status(400).json({ 
        error: 'Invalid status', 
        message: 'Report has already been processed' 
      });
    }

    // Update report status
    await CopyrightReportModel.updateOne(
      { _id: id },
      {
        status: 'rejected',
        resolvedAt: new Date(),
        resolvedBy: adminUserId,
      }
    );

    logger.info(`[CopyrightController] Copyright report ${id} rejected.`);

    res.json({
      message: 'Copyright report rejected',
      reportId: id,
    });
  } catch (error) {
    logger.error('[CopyrightController] Error rejecting copyright report:', error);
    next(error);
  }
};
