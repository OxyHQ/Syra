import { Request, Response, NextFunction } from 'express';
import { Track, Album, Artist } from '@syra/shared-types';

/**
 * GET /api/library
 * Get user's library (requires auth)
 */
export const getUserLibrary = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Mock - return empty library
    res.json({
      oxyUserId: userId,
      likedTracks: [],
      savedAlbums: [],
      followedArtists: [],
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/library/tracks
 * Get liked tracks (requires auth)
 */
export const getLikedTracks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Mock - return empty tracks
    res.json({
      tracks: [],
      total: 0,
      oxyUserId: userId,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/library/tracks/:id/like
 * Like a track (requires auth)
 */
export const likeTrack = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    res.json({
      success: true,
      message: 'Track liked',
      trackId: id,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/library/tracks/:id/unlike
 * Unlike a track (requires auth)
 */
export const unlikeTrack = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    res.json({
      success: true,
      message: 'Track unliked',
      trackId: id,
    });
  } catch (error) {
    next(error);
  }
};






