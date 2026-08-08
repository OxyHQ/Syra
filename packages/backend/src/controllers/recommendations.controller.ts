import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import {
  getRelatedArtists,
  getSimilarTracks,
  getMadeForYou,
} from '../services/recommendations/recommendationService';
import { toArtistDtos, toTrackDtos } from '../db/catalog/hydrate';
import { isPostgresConnected } from '../db/postgres';
import { getParam, parseBoundedLimit } from '../utils/reqParams';

/**
 * POSTGRES ONLY, because that is now the only database this controller reads.
 *
 * It asked twice — `isDatabaseConnected() && isPostgresConnected()` — and the
 * Mongoose half was correct right up to Task 15: the taste profile, the library
 * and the listening history every personalised read starts from were Mongo, so a
 * guard naming one database passed while the other was down.
 *
 * Task 15 ported the last of them. Verified transitively rather than by grepping
 * this file, because the identical guard in `entityProfile.controller` had its
 * Mongo dependency two hops away: walking this controller's whole import graph
 * (24 files) reaches no `models/` import at all.
 *
 * Leaving the Mongoose half would have cost twice over — Mongo down with
 * Postgres up answers 503 for reads that would have succeeded, and at Task 19
 * `readyState` never reaches 1 again, so every route here 503s permanently.
 */

/** Discovery responses are user-scoped where personalised, public otherwise. */
function setPublicDiscoveryCache(res: Response): void {
  res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=600');
}
function setPrivateDiscoveryCache(res: Response): void {
  res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
  res.set('Vary', 'Authorization');
}

/**
 * GET /api/artists/:id/related
 * Artists fans of this artist also listen to (collaborative graph + fallbacks).
 */
export const getRelatedArtistsHandler = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) return res.status(503).json({ error: 'Database not available' });
    const id = getParam(req, 'id');
    const limit = parseBoundedLimit(req.query.limit, 20, 50);
    const artists = await getRelatedArtists(id, limit);
    setPublicDiscoveryCache(res);
    res.json({ artists: await toArtistDtos(artists), total: artists.length });
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
    if (!isPostgresConnected()) return res.status(503).json({ error: 'Database not available' });
    const id = getParam(req, 'id');
    const limit = parseBoundedLimit(req.query.limit, 20, 50);
    const tracks = await getSimilarTracks(id, limit);
    setPublicDiscoveryCache(res);
    res.json({ tracks: await toTrackDtos(tracks), total: tracks.length });
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
    if (!isPostgresConnected()) return res.status(503).json({ error: 'Database not available' });
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const limit = parseBoundedLimit(req.query.limit, 20, 50);
    const result = await getMadeForYou(userId, limit);

    setPrivateDiscoveryCache(res);
    res.json({
      tracks: await toTrackDtos(result.tracks),
      artists: await toArtistDtos(result.artists),
      personalized: result.personalized,
    });
  } catch (error) {
    next(error);
  }
};
