import { and, asc, eq } from 'drizzle-orm';
import { isLiveEntityId } from '@oxyhq/db';
import type { Request, Response, NextFunction } from 'express';
import { getDb, isPostgresConnected } from '../db/postgres';
import { trackHlsRenditions, tracks } from '../db/schema/catalog';
import { playableTrackFilter } from '../db/catalog/visibility';
import { getParam } from '../utils/reqParams';
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
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const trackId = getParam(req, 'trackId');
    if (!trackId || !isLiveEntityId(trackId)) {
      return res.status(404).json({ error: 'Preview not available' });
    }

    const [track] = await getDb()
      .select({
        id: tracks.id,
        artistId: tracks.artistId,
        albumId: tracks.albumId,
        title: tracks.title,
        duration: tracks.duration,
        audioSourceUrl: tracks.audioSourceUrl,
        audioSourceFormat: tracks.audioSourceFormat,
        audioSourceBitrate: tracks.audioSourceBitrate,
        audioSourceDuration: tracks.audioSourceDuration,
      })
      .from(tracks)
      .where(and(playableTrackFilter(), eq(tracks.id, trackId)))
      .limit(1);

    if (!track) {
      return res.status(404).json({ error: 'Preview not available' });
    }

    const durationSec = Number.isFinite(track.duration) ? track.duration : 0;
    const maxStart = Math.max(0, Math.floor(durationSec) - PREVIEW_DURATION_SEC);
    const startSec = clampStart(req.query.start, maxStart);

    const hasRetainedSource = Boolean(track.audioSourceUrl && track.audioSourceFormat);

    /**
     * The ladder is the SECOND regeneration source, tried only when no original
     * was retained — so it is read only in that case rather than on every
     * request. `ensurePreviewClip` prefers `audioSource` and falls back to
     * `hls`, and a cache hit needs neither.
     */
    const hls = hasRetainedSource
      ? undefined
      : await getDb()
          .select({
            manifestKey: trackHlsRenditions.manifestKey,
            bitrateKbps: trackHlsRenditions.bitrateKbps,
            encrypted: trackHlsRenditions.encrypted,
          })
          .from(trackHlsRenditions)
          .where(eq(trackHlsRenditions.trackId, trackId))
          .orderBy(asc(trackHlsRenditions.position));

    /**
     * Every optional key is spread conditionally rather than assigned a `null`.
     * Postgres returns `null` where Mongo simply had no key, and every optional
     * field on `PreviewSourceRef` is `?:` (undefined), not nullable — handing a
     * `null` through would put one on a field typed `string | undefined`.
     */
    const trackRef: PreviewSourceRef = {
      id: track.id,
      artistId: track.artistId,
      ...(track.albumId === null ? {} : { albumId: track.albumId }),
      title: track.title,
      ...(track.audioSourceUrl && track.audioSourceFormat
        ? {
            audioSource: {
              url: track.audioSourceUrl,
              format: track.audioSourceFormat,
              ...(track.audioSourceBitrate === null ? {} : { bitrate: track.audioSourceBitrate }),
              ...(track.audioSourceDuration === null ? {} : { duration: track.audioSourceDuration }),
            },
          }
        : {}),
      ...(hls === undefined ? {} : { hls }),
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
