import mongoose from 'mongoose';
import type { Request, Response, NextFunction } from 'express';
import { TrackModel } from '../models/Track';
import { isDatabaseConnected } from '../utils/database';
import { getParam } from '../utils/reqParams';
import { playableTrackFilter } from '../utils/catalogVisibility';
import { ensurePreviewClip } from '../services/preview/previewService';
import type { PreviewSourceRef } from '../services/preview/previewService';
import { streamFromS3 } from '../services/s3Service';
import { PREVIEW_CONTENT_TYPE, PREVIEW_DURATION_SEC } from '../services/ingest/previewClip';
import { logger } from '../utils/logger';

// Preview clips are immutable for a given (trackId, startSec) → cache hard.
const PREVIEW_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Clamp a requested start offset into `[0, max]`. Non-numeric / negative inputs
 * default to 0. The result is an integer second offset.
 */
function clampStart(value: unknown, max: number): number {
  const parsed = typeof value === 'string' ? parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.min(Math.trunc(parsed), max);
}

/**
 * GET /api/preview/:trackId.mp3?start=N
 *
 * Public, unauthenticated 30s preview of a track. Serves audio to any visitor
 * (including guests). The clip is lazily generated from the retained source on
 * first request and cached in S3 thereafter.
 *
 * Returns 404 when the track is not guest-playable or is not preview-eligible
 * (no regenerable source) — never leaks why.
 */
export const getTrackPreview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const trackId = getParam(req, 'trackId');
    if (!trackId || !mongoose.Types.ObjectId.isValid(trackId)) {
      return res.status(404).json({ error: 'Preview not available' });
    }

    const track = await TrackModel.findOne(playableTrackFilter({ _id: trackId })).lean();
    if (!track) {
      return res.status(404).json({ error: 'Preview not available' });
    }

    const durationSec = Number.isFinite(track.duration) ? track.duration : 0;
    const maxStart = Math.max(0, Math.floor(durationSec) - PREVIEW_DURATION_SEC);
    const startSec = clampStart(req.query.start, maxStart);

    const trackRef: PreviewSourceRef = {
      id: track._id.toString(),
      artistId: track.artistId,
      albumId: track.albumId,
      title: track.title,
      audioSource: track.audioSource,
      hls: track.hls,
    };

    const previewKey = await ensurePreviewClip(trackRef, startSec);
    if (!previewKey) {
      return res.status(404).json({ error: 'Preview not available' });
    }

    const { stream, contentLength } = await streamFromS3(previewKey);

    stream.on('error', (streamError: Error) => {
      logger.error('[PreviewController] Error reading preview stream', { trackId, err: streamError });
      if (!res.headersSent) {
        res.status(404).json({ error: 'Preview not available' });
      } else {
        res.end();
      }
    });

    res.setHeader('Content-Type', PREVIEW_CONTENT_TYPE);
    if (contentLength > 0) {
      res.setHeader('Content-Length', String(contentLength));
    }
    res.setHeader('Cache-Control', PREVIEW_CACHE_CONTROL);
    res.setHeader('Accept-Ranges', 'bytes');

    stream.pipe(res);
  } catch (error: unknown) {
    logger.error('[PreviewController] Error serving preview', { err: error });
    next(error);
  }
};
