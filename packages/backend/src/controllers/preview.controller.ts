import mongoose from 'mongoose';
import type { Request, Response, NextFunction } from 'express';
import { TrackModel } from '../models/Track';
import { isDatabaseConnected } from '../utils/database';
import { getParam } from '../utils/reqParams';
import { playableTrackFilter } from '../utils/catalogVisibility';
import { ensurePreviewClip } from '../services/preview/previewService';
import type { PreviewSourceRef } from '../services/preview/previewService';
import { streamFromS3 } from '../services/s3Service';
import { PREVIEW_CONTENT_TYPE } from '../services/ingest/previewClip';
import { logger } from '../utils/logger';

// Public preview clips are fixed to one curated excerpt per track. Keeping the
// offset constant prevents unauthenticated callers from creating unbounded lazy
// transcode/cache-miss work or enumerating most of a track through previews.
const PUBLIC_PREVIEW_START_SEC = 0;
const PREVIEW_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * GET /api/preview/:trackId.mp3
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

    // The preview is a public surface: always resolve playability for a guest
    // (no direct Audius streaming), independent of any optional session.
    const track = await TrackModel.findOne(playableTrackFilter({ _id: trackId }, {})).lean();
    if (!track) {
      return res.status(404).json({ error: 'Preview not available' });
    }

    const trackRef: PreviewSourceRef = {
      id: track._id.toString(),
      artistId: track.artistId,
      albumId: track.albumId,
      title: track.title,
      audioSource: track.audioSource,
      hls: track.hls,
    };

    const previewKey = await ensurePreviewClip(trackRef, PUBLIC_PREVIEW_START_SEC);
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
