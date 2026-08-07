import { Response, NextFunction } from 'express';
import { and, inArray } from 'drizzle-orm';
import { isForeignKeyViolation, isLiveEntityId } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getDb } from '../db/postgres';
import { tracks } from '../db/schema/catalog';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { toTrackDtos } from '../db/catalog/hydrate';
import { playableTrackFilter } from '../db/catalog/visibility';
import {
  addMembership,
  listMembership,
  removeMembership,
  type MembershipKind,
} from '../db/library/membership';
import {
  findRecentTrackIds,
  prunePlayHistory,
  recordPlayEvent,
  touchRecentPlay,
} from '../db/library/recentlyPlayed';
import { getParam, parseBoundedLimit } from '../utils/reqParams';
import { recordPlay } from '../services/recommendations/recordPlay';
import { applyLikeSignal, applyFollowSignal } from '../services/recommendations/tasteSignals';
import { LISTENING_SOURCES } from '../db/schema/user';
import type { ListeningSource } from '../db/user/listening';

/**
 * The playable tracks behind a list of ids, in no particular order.
 *
 * `inArray(column, [])` generates `in ()`, which is a SYNTAX ERROR in Postgres
 * rather than an empty result — so the empty case is answered without a query,
 * the same guard `db/catalog/hydrate.ts`'s `loadImageVariants` carries.
 */
async function findPlayableTracksByIds(ids: readonly string[]) {
  if (ids.length === 0) return [];
  return getDb()
    .select(publicColumns(tracks, PROTECTED_COLUMNS_BY_TABLE))
    .from(tracks)
    .where(and(playableTrackFilter(), inArray(tracks.id, [...ids])));
}

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
 * The 404 body a membership write answers with when the id names nothing.
 *
 * A bare `$addToSet` stored any string; each junction table's target is a real
 * foreign key, so the database now answers the existence question the handlers
 * never asked. See `db/library/membership.ts` for why that makes adding
 * fallible while removing stays a no-op.
 */
const MISSING_TARGET_MESSAGE: Readonly<Record<MembershipKind, string>> = {
  likedTracks: 'Track not found',
  savedAlbums: 'Album not found',
  followedArtists: 'Artist not found',
  savedPlaylists: 'Playlist not found',
};

/**
 * Add one membership and answer with the user's full updated list — the
 * response shape every one of these endpoints has always had.
 *
 * Returns `null` when the id names nothing, so the caller can 404 before
 * running any side effect that assumes the entity exists (the taste signals
 * behind a like and a follow both do).
 */
async function addToLibrary(
  oxyUserId: string,
  kind: MembershipKind,
  entityId: string
): Promise<string[] | null> {
  if ((await addMembership(kind, oxyUserId, entityId)) === 'missing-target') return null;
  return listMembership(kind, oxyUserId);
}

/** Remove one membership and answer with the user's full updated list. */
async function removeFromLibrary(
  oxyUserId: string,
  kind: MembershipKind,
  entityId: string
): Promise<string[]> {
  await removeMembership(kind, oxyUserId, entityId);
  return listMembership(kind, oxyUserId);
}

/**
 * GET /api/library
 * Get the user's library memberships (requires auth).
 * Returns empty arrays for a user who has liked/saved/followed nothing.
 */
export const getUserLibrary = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const [likedTracks, savedAlbums, followedArtists, savedPlaylists] = await Promise.all([
      listMembership('likedTracks', userId),
      listMembership('savedAlbums', userId),
      listMembership('followedArtists', userId),
      listMembership('savedPlaylists', userId),
    ]);

    res.json({ oxyUserId: userId, likedTracks, savedAlbums, followedArtists, savedPlaylists });
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

    const likedTrackIds = await listMembership('likedTracks', userId);

    if (likedTrackIds.length === 0) {
      return res.json({ tracks: [], total: 0, oxyUserId: userId });
    }

    const formattedTracks = await toTrackDtos(await findPlayableTracksByIds(likedTrackIds));

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
    if (!likedTracks) {
      return res.status(404).json({ error: MISSING_TARGET_MESSAGE.likedTracks });
    }

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
    if (!savedAlbums) {
      return res.status(404).json({ error: MISSING_TARGET_MESSAGE.savedAlbums });
    }

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
    if (!followedArtists) {
      return res.status(404).json({ error: MISSING_TARGET_MESSAGE.followedArtists });
    }

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
    if (!savedPlaylists) {
      return res.status(404).json({ error: MISSING_TARGET_MESSAGE.savedPlaylists });
    }

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

    // The limit arrives as a route param on one mount and a query param on the other.
    const limit = parseBoundedLimit(
      getParam(req, 'limit') || req.query.limit,
      RECENTLY_PLAYED_DEFAULT_LIMIT,
      RECENTLY_PLAYED_MAX_LIMIT,
    );

    // Plays collapsed to the most recent occurrence per track, newest first.
    // No id-shape filter on the way out: `recently_played.track_id` is a real
    // foreign key, so every id here names a row — and the catalog query below
    // already answers "is it still playable" for free.
    const orderedTrackIds = await findRecentTrackIds(userId, limit);

    if (orderedTrackIds.length === 0) {
      return res.json({ tracks: [] });
    }

    const formattedTracks = await toTrackDtos(await findPlayableTracksByIds(orderedTrackIds));

    // An `in (…)` does not honour the list's order; re-sort to match recency
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
    if (!isLiveEntityId(trackId)) {
      return res.status(400).json({ error: 'Invalid trackId' });
    }

    const now = new Date();
    const dedupSince = new Date(now.getTime() - RECENTLY_PLAYED_DEDUP_WINDOW_MS);

    // If the same track was logged very recently, just bump its timestamp.
    if (!(await touchRecentPlay(userId, trackId, dedupSince, now))) {
      // `recently_played.track_id` references `tracks`, so an id that is
      // well-formed but names nothing is `23503` rather than a stored row —
      // the same answer `likeTrack` gives, for the same reason.
      try {
        await recordPlayEvent(userId, trackId, now);
      } catch (error) {
        if (isForeignKeyViolation(error, 'recently_played_track_id_tracks_id_fk')) {
          return res.status(404).json({ error: 'Track not found' });
        }
        throw error;
      }

      await prunePlayHistory(userId, RECENTLY_PLAYED_RETENTION);
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
