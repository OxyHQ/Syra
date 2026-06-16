import { Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { AuthRequest } from '../middleware/auth';
import { UserLibraryModel } from '../models/Library';
import { TrackModel } from '../models/Track';
import { formatTracksWithCoverArt } from '../utils/musicHelpers';
import { getParam } from '../utils/reqParams';

/**
 * Membership arrays on the user's library document. Each is an idempotent
 * set of catalog entity IDs the user has liked/saved/followed.
 */
type MembershipField =
  | 'likedTracks'
  | 'savedAlbums'
  | 'followedArtists'
  | 'savedPlaylists';

/**
 * Add a catalog entity ID to a membership array, upserting the user's library
 * document if it does not yet exist. Idempotent via `$addToSet`.
 * Returns the updated membership array.
 */
async function addToLibrary(
  oxyUserId: string,
  field: MembershipField,
  entityId: string
): Promise<string[]> {
  const library = await UserLibraryModel.findOneAndUpdate(
    { oxyUserId },
    { $addToSet: { [field]: entityId } },
    { upsert: true, new: true }
  ).lean();

  return library?.[field] ?? [];
}

/**
 * Remove a catalog entity ID from a membership array. Upserts the user's
 * library document so removing from an empty library is a no-op (not a 404).
 * Idempotent via `$pull`. Returns the updated membership array.
 */
async function removeFromLibrary(
  oxyUserId: string,
  field: MembershipField,
  entityId: string
): Promise<string[]> {
  const library = await UserLibraryModel.findOneAndUpdate(
    { oxyUserId },
    { $pull: { [field]: entityId } },
    { upsert: true, new: true }
  ).lean();

  return library?.[field] ?? [];
}

/**
 * GET /api/library
 * Get the user's library membership arrays (requires auth).
 * Returns empty arrays if the user has no library document yet.
 */
export const getUserLibrary = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const library = await UserLibraryModel.findOne({ oxyUserId: userId }).lean();

    res.json({
      oxyUserId: userId,
      likedTracks: library?.likedTracks ?? [],
      savedAlbums: library?.savedAlbums ?? [],
      followedArtists: library?.followedArtists ?? [],
      savedPlaylists: library?.savedPlaylists ?? [],
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/library/tracks
 * Get the user's liked tracks as full track objects (requires auth).
 */
export const getLikedTracks = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const library = await UserLibraryModel.findOne({ oxyUserId: userId }).lean();
    const likedTrackIds = library?.likedTracks ?? [];

    if (likedTrackIds.length === 0) {
      return res.json({ tracks: [], total: 0, oxyUserId: userId });
    }

    // Only valid ObjectIds can match a Track _id; ignore any stale/invalid ids.
    const validTrackIds = likedTrackIds.filter((id) => mongoose.Types.ObjectId.isValid(id));

    const tracks = await TrackModel.find({
      _id: { $in: validTrackIds },
      isAvailable: true,
    }).lean();

    const formattedTracks = await formatTracksWithCoverArt(tracks);

    res.json({
      tracks: formattedTracks,
      total: formattedTracks.length,
      oxyUserId: userId,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/library/tracks/:id/like
 * Like a track (requires auth). Idempotent.
 */
export const likeTrack = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const likedTracks = await addToLibrary(userId, 'likedTracks', id);
    res.json({ ok: true, likedTracks });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/library/tracks/:id/unlike
 * Unlike a track (requires auth). Idempotent.
 */
export const unlikeTrack = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const likedTracks = await removeFromLibrary(userId, 'likedTracks', id);
    res.json({ ok: true, likedTracks });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/library/albums/:id/save
 * Save an album (requires auth). Idempotent.
 */
export const saveAlbum = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const savedAlbums = await addToLibrary(userId, 'savedAlbums', id);
    res.json({ ok: true, savedAlbums });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/library/albums/:id/unsave
 * Unsave an album (requires auth). Idempotent.
 */
export const unsaveAlbum = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const savedAlbums = await removeFromLibrary(userId, 'savedAlbums', id);
    res.json({ ok: true, savedAlbums });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/library/artists/:id/follow
 * Follow an artist (requires auth). Idempotent.
 */
export const followArtist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const followedArtists = await addToLibrary(userId, 'followedArtists', id);
    res.json({ ok: true, followedArtists });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/library/artists/:id/unfollow
 * Unfollow an artist (requires auth). Idempotent.
 */
export const unfollowArtist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const followedArtists = await removeFromLibrary(userId, 'followedArtists', id);
    res.json({ ok: true, followedArtists });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/library/playlists/:id/save
 * Save a playlist (requires auth). Idempotent.
 */
export const savePlaylist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const savedPlaylists = await addToLibrary(userId, 'savedPlaylists', id);
    res.json({ ok: true, savedPlaylists });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/library/playlists/:id/unsave
 * Unsave a playlist (requires auth). Idempotent.
 */
export const unsavePlaylist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const savedPlaylists = await removeFromLibrary(userId, 'savedPlaylists', id);
    res.json({ ok: true, savedPlaylists });
  } catch (error) {
    next(error);
  }
};
