import { Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { UserLibraryModel } from '../models/Library';
import { RecentlyPlayedModel } from '../models/RecentlyPlayed';
import { TrackModel } from '../models/Track';
import { formatTracksWithCoverArt } from '../utils/musicHelpers';
import { getParam } from '../utils/reqParams';
import { recordPlay } from '../services/recommendations/recordPlay';
import { applyLikeSignal, applyFollowSignal } from '../services/recommendations/tasteSignals';
import { LISTENING_SOURCES, type ListeningSource } from '../models/ListeningEvent';
import { playableTrackFilter, resolveCatalogPlaybackOptions } from '../utils/catalogVisibility';

/** Validate a client-supplied listening source against the known set. */
function parseListeningSource(value: unknown): ListeningSource {
  if (typeof value !== 'string') return 'unknown';
  const source = value.trim();
  return LISTENING_SOURCES.includes(source as ListeningSource) ? (source as ListeningSource) : 'unknown';
}

function parseOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value >= 0 ? value : undefined;
}

/** Default number of distinct recent tracks returned by GET /recently-played. */
const RECENTLY_PLAYED_DEFAULT_LIMIT = 20;
/** Hard cap on the limit query param to keep responses bounded. */
const RECENTLY_PLAYED_MAX_LIMIT = 50;
/** Most recent play documents retained per user; older rows are pruned. */
const RECENTLY_PLAYED_RETENTION = 100;
/**
 * Window within which a repeated play of the same track refreshes the existing
 * row's timestamp instead of inserting a new one, avoiding duplicate stacking
 * from rapid replays/seeks.
 */
const RECENTLY_PLAYED_DEDUP_WINDOW_MS = 30 * 1000;

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
    const playbackOptions = await resolveCatalogPlaybackOptions(userId);

    if (likedTrackIds.length === 0) {
      return res.json({ tracks: [], total: 0, oxyUserId: userId });
    }

    // Only valid ObjectIds can match a Track _id; ignore any stale/invalid ids.
    const validTrackIds = likedTrackIds.filter((id) => mongoose.Types.ObjectId.isValid(id));

    const tracks = await TrackModel.find(playableTrackFilter({
      _id: { $in: validTrackIds },
    }, playbackOptions)).lean();

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
    await applyLikeSignal(userId, id);
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
    await applyFollowSignal(userId, id);
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

/**
 * GET /api/library/recently-played?limit=N
 * Get the user's most recently played tracks as full track objects, deduped by
 * trackId (newest play wins) and filtered to available tracks (requires auth).
 */
export const getRecentlyPlayed = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const requested = Number(getParam(req, 'limit') || req.query.limit);
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), RECENTLY_PLAYED_MAX_LIMIT)
        : RECENTLY_PLAYED_DEFAULT_LIMIT;

    // Collapse plays to the most recent occurrence per trackId, newest first.
    // We over-fetch (retention window) so duplicate plays don't starve the list
    // below `limit` distinct tracks before slicing.
    const recent = await RecentlyPlayedModel.aggregate<{ _id: string; playedAt: Date }>([
      { $match: { oxyUserId: userId } },
      { $sort: { playedAt: -1 } },
      { $group: { _id: '$trackId', playedAt: { $first: '$playedAt' } } },
      { $sort: { playedAt: -1 } },
      { $limit: limit },
    ]);

    if (recent.length === 0) {
      return res.json({ tracks: [] });
    }

    // Preserve recency order from the aggregation when resolving Track docs.
    const orderedTrackIds = recent
      .map((entry) => entry._id)
      .filter((id) => mongoose.Types.ObjectId.isValid(id));

    if (orderedTrackIds.length === 0) {
      return res.json({ tracks: [] });
    }
    const playbackOptions = await resolveCatalogPlaybackOptions(userId);

    const tracks = await TrackModel.find(playableTrackFilter({
      _id: { $in: orderedTrackIds },
    }, playbackOptions)).lean();

    const formattedTracks = await formatTracksWithCoverArt(tracks);

    // TrackModel.find does not honour the $in order; re-sort to match recency
    // and drop any ids that resolved to no available track.
    const orderIndex = new Map(orderedTrackIds.map((id, index) => [id, index]));
    const sortedTracks = formattedTracks
      .filter((track) => orderIndex.has(track.id))
      .sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));

    res.json({ tracks: sortedTracks });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/library/recently-played
 * Body: { trackId: string }
 * Record a play of a track for the current user. A repeated play of the same
 * track within a short window refreshes the existing row instead of stacking a
 * duplicate; storage is capped to the most recent plays per user (requires auth).
 */
export const recordRecentlyPlayed = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const rawTrackId: unknown = req.body?.trackId;
    const trackId = typeof rawTrackId === 'string' ? rawTrackId.trim() : '';

    if (!trackId) {
      return res.status(400).json({ error: 'trackId is required' });
    }
    if (!mongoose.Types.ObjectId.isValid(trackId)) {
      return res.status(400).json({ error: 'Invalid trackId' });
    }

    const now = new Date();
    const dedupSince = new Date(now.getTime() - RECENTLY_PLAYED_DEDUP_WINDOW_MS);

    // If the same track was logged very recently, just bump its timestamp.
    const refreshed = await RecentlyPlayedModel.findOneAndUpdate(
      { oxyUserId: userId, trackId, playedAt: { $gte: dedupSince } },
      { $set: { playedAt: now } },
      { new: true }
    ).lean();

    if (!refreshed) {
      await RecentlyPlayedModel.create({ oxyUserId: userId, trackId, playedAt: now });

      // Prune anything beyond the retention window for this user.
      const cutoff = await RecentlyPlayedModel.find({ oxyUserId: userId })
        .sort({ playedAt: -1 })
        .skip(RECENTLY_PLAYED_RETENTION)
        .limit(1)
        .select({ playedAt: 1 })
        .lean();

      const cutoffPlayedAt = cutoff[0]?.playedAt;
      if (cutoffPlayedAt) {
        await RecentlyPlayedModel.deleteMany({
          oxyUserId: userId,
          playedAt: { $lte: cutoffPlayedAt },
        });
      }
    }

    // Feed the recommendation engine ONLY when the client reports engagement
    // signals (how much of the track was actually heard). The player sends a
    // first, signal-less ping when a track starts (to populate "Jump back in"
    // instantly) and a second one carrying listenedSec/completion when the play
    // ends or is skipped. Gating recordPlay on the presence of signals keeps the
    // global play count and taste profile driven by the engagement ping alone,
    // so a single play is never double-counted.
    const listenedSec = parseOptionalNonNegativeNumber(req.body?.listenedSec);
    const completion = parseOptionalNonNegativeNumber(req.body?.completion);
    let listening: Awaited<ReturnType<typeof recordPlay>> | null = null;
    if (listenedSec !== undefined || completion !== undefined) {
      listening = await recordPlay({
        oxyUserId: userId,
        trackId,
        listenedSec,
        completion,
        source: parseListeningSource(req.body?.source),
      });
    }

    res.json({ ok: true, listening });
  } catch (error) {
    next(error);
  }
};
