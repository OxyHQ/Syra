import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import {
  getRelatedArtists,
  getSimilarTracks,
  getTrackRadio,
  getMadeForYou,
} from '../services/recommendations/recommendationService';
import {
  formatTracksWithCoverArt,
  formatArtistsWithImage,
} from '../utils/musicHelpers';
import { isDatabaseConnected } from '../utils/database';
import { getParam } from '../utils/reqParams';

/** Discovery responses are user-scoped where personalised, public otherwise. */
function setPublicDiscoveryCache(res: Response): void {
  res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=600');
}
function setPrivateDiscoveryCache(res: Response): void {
  res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
  res.set('Vary', 'Authorization');
}

function boundedLimit(value: unknown, fallback: number, max: number): number {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * GET /api/artists/:id/related
 * Artists fans of this artist also listen to (collaborative graph + fallbacks).
 */
export const getRelatedArtistsHandler = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) return res.status(503).json({ error: 'Database not available' });
    const id = getParam(req, 'id');
    const limit = boundedLimit(req.query.limit, 20, 50);
    const artists = await getRelatedArtists(id, limit);
    setPublicDiscoveryCache(res);
    res.json({ artists: formatArtistsWithImage(artists), total: artists.length });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/tracks/:id/similar
 * Tracks similar to this one (collaborative graph + content fallbacks).
 */
export const getSimilarTracksHandler = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) return res.status(503).json({ error: 'Database not available' });
    const id = getParam(req, 'id');
    const limit = boundedLimit(req.query.limit, 20, 50);
    const tracks = await getSimilarTracks(id, limit);
    setPublicDiscoveryCache(res);
    res.json({ tracks: await formatTracksWithCoverArt(tracks), total: tracks.length });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/tracks/:id/radio
 * A radio station seeded from this track for autoplay queue population.
 */
export const getTrackRadioHandler = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) return res.status(503).json({ error: 'Database not available' });
    const id = getParam(req, 'id');
    const limit = boundedLimit(req.query.limit, 30, 100);
    const tracks = await getTrackRadio(id, limit);
    setPublicDiscoveryCache(res);
    res.json({ tracks: await formatTracksWithCoverArt(tracks), total: tracks.length });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/recommendations/made-for-you
 * Personalised tracks + artists for the signed-in user, learned from their
 * taste profile. Falls back to popular content (flagged) on cold start.
 * Requires auth.
 */
export const getMadeForYouHandler = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) return res.status(503).json({ error: 'Database not available' });
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const limit = boundedLimit(req.query.limit, 20, 50);
    const result = await getMadeForYou(userId, limit);

    setPrivateDiscoveryCache(res);
    res.json({
      tracks: await formatTracksWithCoverArt(result.tracks),
      artists: formatArtistsWithImage(result.artists),
      personalized: result.personalized,
    });
  } catch (error) {
    next(error);
  }
};
