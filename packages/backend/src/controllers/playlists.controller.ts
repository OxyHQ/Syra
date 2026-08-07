import { Response, NextFunction } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { isForeignKeyViolation, isLiveEntityId } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import { PlaylistVisibility, playlistVisibilitySchema } from '@syra/shared-types';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getDb } from '../db/postgres';
import { tracks } from '../db/schema/catalog';
import { playlistTracks, playlists } from '../db/schema/library';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { loadImageVariants, toPlaylistDtos, toTrackDtos } from '../db/catalog/hydrate';
import { toPlaylistDto, type PlaylistRow, type PublicTrackRow } from '../db/catalog/serialize';
import { canViewPlaylist, playableTrackFilter } from '../db/catalog/visibility';
import {
  assignPlaylistTrackPositions,
  findCollaboratorOxyUserIds,
  findCollaboratorRole,
  findExistingPlaylistTrackIds,
  findPlayableTrackIds,
  findPlaylistById,
  findPlaylistCollaborators,
  findPlaylistTracks,
  findPlaylistsForUser,
  refreshPlaylistStats,
} from '../db/library/playlists';
import { getStoredImageColors } from '../utils/imageColors';
import { getParam } from '../utils/reqParams';

interface PlaylistAuthRequest extends AuthRequest {
  user?: AuthRequest['user'] & {
    username?: string;
  };
}

/**
 * Why a rejected cover art is no longer described as an ObjectId.
 *
 * The message said "a valid MongoDB ObjectId string (24 hex characters)" and
 * the check behind it was `mongoose.Types.ObjectId.isValid`. Every image
 * uploaded since the cutover gets a uuid v7 from
 * `services/imageAssetService.ts`, so that check rejected every real cover art
 * id — a live 400 on a working upload. `isLiveEntityId` accepts both shapes,
 * which is what `albums.controller` already does.
 */
const INVALID_COVER_ART = {
  error: 'Invalid coverArt',
  message:
    'coverArt must be a valid image ID. Images must be uploaded first using /api/images/upload.',
} as const;

/**
 * The one foreign key a client-supplied `coverArt` can break.
 *
 * `playlists` has seven `image_assets` references; this handler writes exactly
 * one of them, so the constraint is named rather than matched on the bare
 * SQLSTATE — a `23503` from any of the other six would be a bug in this
 * server, not a bad request, and must not be answered with a 400.
 *
 * The existence check is the foreign key itself rather than a read, because
 * the read that looks like it would answer does not:
 * `getStoredImageColors` returns `undefined` both for an image that does not
 * exist AND for one that exists with no extracted palette, so using it as a
 * guard would reject a perfectly good cover.
 */
const COVER_ART_FOREIGN_KEY = 'playlists_cover_art_id_image_assets_id_fk';

/** A client-supplied cover art that is a URL of some kind rather than an id. */
function looksLikeUrl(value: string): boolean {
  return (
    value.startsWith('blob:') ||
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('/api/')
  );
}

/** The playable tracks behind a list of ids, in no particular order. */
async function findPlayableTracks(ids: readonly string[]): Promise<PublicTrackRow[]> {
  if (ids.length === 0) return [];
  return getDb()
    .select(publicColumns(tracks, PROTECTED_COLUMNS_BY_TABLE))
    .from(tracks)
    .where(and(playableTrackFilter(), inArray(tracks.id, [...ids])));
}

/**
 * Serialize one playlist, with its collaborators.
 *
 * The collaborator list is loaded here rather than left absent, because this
 * API is the surface that renders it — `db/catalog/hydrate.ts`'s
 * `toPlaylistDtos` deliberately omits it for discovery shelves that show only
 * a name and a cover, and would otherwise pay a join per page for a field
 * nothing on them shows.
 */
async function toPlaylistResponse(row: PlaylistRow) {
  const [lookup, collaborators] = await Promise.all([
    loadImageVariants([
      row.coverArtId,
      row.coverArtSizesSmallId,
      row.coverArtSizesMediumId,
      row.coverArtSizesLargeId,
      row.coverArtSizesXlargeId,
      row.coverArtSizesXxlargeId,
      row.coverArtSizesOriginalId,
    ]),
    findPlaylistCollaborators(row.id),
  ]);

  return toPlaylistDto(row, lookup, { collaborators });
}

/**
 * Check if user has permission to edit playlist
 */
async function canEditPlaylist(playlistId: string, userId: string): Promise<boolean> {
  const playlist = await findPlaylistById(playlistId);
  if (!playlist) return false;

  // Owner can always edit
  if (playlist.ownerOxyUserId === userId) return true;

  // Check if user is a collaborator with editor role
  const role = await findCollaboratorRole(playlistId, userId);
  return role === 'editor' || role === 'owner';
}

/**
 * The playlist, if this viewer may read it.
 *
 * `'forbidden'` covers a playlist that does not exist as well as one the
 * viewer may not see — the behaviour this endpoint has always had, since the
 * Mongo `canViewPlaylistById` answered `false` for a missing playlist and the
 * caller turned that into a 403 (which made the 404 branch after it dead
 * code). It is also the answer that leaks least: a 404 would tell a stranger
 * which private playlist ids are real.
 */
async function readablePlaylist(
  playlistId: string,
  userId?: string
): Promise<PlaylistRow | 'forbidden'> {
  const playlist = await findPlaylistById(playlistId);
  if (!playlist) return 'forbidden';

  const collaboratorOxyUserIds = await findCollaboratorOxyUserIds(playlistId);
  return canViewPlaylist({ ...playlist, collaboratorOxyUserIds }, userId) ? playlist : 'forbidden';
}

/**
 * GET /api/playlists
 * Get user's playlists (requires auth)
 */
export const getUserPlaylists = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const formattedPlaylists = await toPlaylistDtos(await findPlaylistsForUser(userId));

    res.json({
      playlists: formattedPlaylists,
      total: formattedPlaylists.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/playlists/:id
 * Get playlist by ID (public if playlist is public)
 */
export const getPlaylistById = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const playlist = await readablePlaylist(getParam(req, 'id'), req.user?.id);
    if (playlist === 'forbidden') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(await toPlaylistResponse(playlist));
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/playlists/:id/tracks
 * Get tracks in playlist
 */
export const getPlaylistTracks = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = getParam(req, 'id');

    if ((await readablePlaylist(id, req.user?.id)) === 'forbidden') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Membership rows in playlist order, then the playable tracks behind them.
    // Two queries rather than a join because a track that is no longer playable
    // has to drop out of BOTH lists together, and the pairing is what says so.
    const membership = await findPlaylistTracks(id);
    const trackById = new Map(
      (await findPlayableTracks(membership.map((entry) => entry.trackId))).map((row) => [
        row.id,
        row,
      ])
    );

    const ordered = membership.flatMap((entry) => {
      const track = trackById.get(entry.trackId);
      return track ? [{ entry, track }] : [];
    });

    res.json({
      tracks: await toTrackDtos(ordered.map(({ track }) => track)),
      playlistTracks: ordered.map(({ entry }) => ({
        trackId: entry.trackId,
        addedAt: entry.addedAt.toISOString(),
        addedBy: entry.addedBy ?? undefined,
        // `order` on the wire, `position` in the column: the schema renamed it
        // (`order` is a reserved SQL keyword) and `playlistTrackSchema` in
        // `@syra/shared-types` did not.
        order: entry.position,
      })),
      total: ordered.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/playlists
 * Create playlist (requires auth)
 */
export const createPlaylist = async (req: PlaylistAuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // After the guard, not before it: `owner_username` is `NOT NULL`, and the
    // account id is the fallback when the token carries no username.
    const username = req.user?.username || userId;

    const { name, description, coverArt, visibility } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Playlist name is required' });
    }

    // `playlists.visibility` carries a CHECK constraint; the Mongoose enum
    // rejected a bad value with a 500 (a ValidationError from `save`). Parsed
    // against the shared contract instead, so the client gets a 400 naming the
    // field — the answer the update handler below already gave.
    const requestedVisibility = playlistVisibilitySchema.optional().safeParse(visibility);
    if (!requestedVisibility.success) {
      return res.status(400).json({ error: 'Invalid visibility value' });
    }

    let coverArtId: string | undefined;
    let colors: { primaryColor?: string; secondaryColor?: string } | undefined;
    if (coverArt !== undefined && coverArt !== null && coverArt !== '') {
      if (typeof coverArt !== 'string' || looksLikeUrl(coverArt) || !isLiveEntityId(coverArt)) {
        return res.status(400).json(INVALID_COVER_ART);
      }
      coverArtId = coverArt;
      colors = await getStoredImageColors(coverArt);
    }

    const created = await insertPlaylist({
      name: name.trim(),
      description: typeof description === 'string' ? description.trim() || undefined : undefined,
      ownerOxyUserId: userId,
      ownerUsername: username,
      coverArtId,
      visibility: requestedVisibility.data ?? PlaylistVisibility.PRIVATE,
      primaryColor: colors?.primaryColor,
      secondaryColor: colors?.secondaryColor,
    });

    if (created === 'unknown-cover-art') {
      return res.status(400).json(INVALID_COVER_ART);
    }

    res.status(201).json(await toPlaylistResponse(created));
  } catch (error) {
    next(error);
  }
};

/** Insert the row, translating the one foreign key a client can break. */
async function insertPlaylist(
  values: typeof playlists.$inferInsert
): Promise<PlaylistRow | 'unknown-cover-art'> {
  try {
    const [created] = await getDb().insert(playlists).values(values).returning();
    if (!created) throw new Error('createPlaylist: insert returned no row');
    return created;
  } catch (error) {
    if (isForeignKeyViolation(error, COVER_ART_FOREIGN_KEY)) return 'unknown-cover-art';
    throw error;
  }
}

/**
 * PUT /api/playlists/:id
 * Update playlist (requires auth and edit permission)
 */
export const updatePlaylist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = getParam(req, 'id');
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check edit permission
    if (!(await canEditPlaylist(id, userId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { name, description, coverArt, visibility } = req.body;

    const updates: Partial<typeof playlists.$inferInsert> = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Playlist name cannot be empty' });
      }
      updates.name = name.trim();
    }
    if (description !== undefined) {
      updates.description = typeof description === 'string' ? description.trim() || null : null;
    }
    if (coverArt !== undefined) {
      if (coverArt !== null && coverArt !== '') {
        if (typeof coverArt !== 'string' || looksLikeUrl(coverArt) || !isLiveEntityId(coverArt)) {
          return res.status(400).json(INVALID_COVER_ART);
        }

        const colors = await getStoredImageColors(coverArt);
        updates.coverArtId = coverArt;
        updates.primaryColor = colors?.primaryColor ?? null;
        updates.secondaryColor = colors?.secondaryColor ?? null;
      } else {
        updates.coverArtId = null;
        updates.primaryColor = null;
        updates.secondaryColor = null;
      }
    }
    if (visibility !== undefined) {
      const parsed = playlistVisibilitySchema.safeParse(visibility);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid visibility value' });
      }
      updates.visibility = parsed.data;
    }

    // A `PUT` naming no writable field is not an error and never was, but
    // drizzle rejects an empty `set()` rather than treating it as a no-op — so
    // the read stands in for it, and `updated_at` correctly does not move.
    const updated =
      Object.keys(updates).length > 0
        ? await applyPlaylistUpdate(id, updates)
        : await findPlaylistById(id);

    if (updated === 'unknown-cover-art') {
      return res.status(400).json(INVALID_COVER_ART);
    }
    if (!updated) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    res.json(await toPlaylistResponse(updated));
  } catch (error) {
    next(error);
  }
};

/** Apply the update, translating the one foreign key a client can break. */
async function applyPlaylistUpdate(
  id: string,
  updates: Partial<typeof playlists.$inferInsert>
): Promise<PlaylistRow | undefined | 'unknown-cover-art'> {
  try {
    const [updated] = await getDb()
      .update(playlists)
      .set(updates)
      .where(eq(playlists.id, id))
      .returning();
    return updated;
  } catch (error) {
    if (isForeignKeyViolation(error, COVER_ART_FOREIGN_KEY)) return 'unknown-cover-art';
    throw error;
  }
}

/**
 * DELETE /api/playlists/:id
 * Delete playlist (requires auth and owner permission)
 */
export const deletePlaylist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = getParam(req, 'id');
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const playlist = await findPlaylistById(id);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Only owner can delete
    if (playlist.ownerOxyUserId !== userId) {
      return res.status(403).json({ error: 'Only the owner can delete this playlist' });
    }

    // `playlist_tracks`, `playlist_collaborators`, `playlist_sources` and
    // `user_saved_playlists` all reference this row `on delete cascade`, so the
    // explicit `PlaylistTrackModel.deleteMany` this replaced is gone — and so
    // are the saved-playlist rows the Mongo path never cleaned up, a real
    // orphan documented in `db/schema/library.ts`.
    await getDb().delete(playlists).where(eq(playlists.id, id));

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/playlists/:id/tracks
 * Add tracks to playlist (requires auth and edit permission)
 */
export const addTracksToPlaylist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = getParam(req, 'id');
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check edit permission
    if (!(await canEditPlaylist(id, userId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { trackIds, position } = req.body;

    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return res.status(400).json({ error: 'trackIds must be a non-empty array' });
    }

    // Validate track IDs
    const validTrackIds = trackIds.filter((tid: unknown): tid is string => isLiveEntityId(tid));
    if (validTrackIds.length === 0) {
      return res.status(400).json({ error: 'No valid track IDs provided' });
    }

    // Verify tracks exist and are playable
    const playable = new Set(await findPlayableTrackIds(validTrackIds));
    if (playable.size === 0) {
      return res.status(404).json({ error: 'No valid tracks found' });
    }

    const existing = await findPlaylistTracks(id);
    const alreadyPresent = new Set(await findExistingPlaylistTrackIds(id, [...playable]));
    // Deduped against the request as well as against the playlist: the same id
    // twice in one body would otherwise be two rows fighting for one position.
    // `playlist_tracks_playlist_id_track_id_idx` does not stop it — that index
    // is deliberately not unique.
    const newTrackIds = [
      ...new Set(validTrackIds.filter((tid) => playable.has(tid) && !alreadyPresent.has(tid))),
    ];

    if (newTrackIds.length === 0) {
      return res.status(400).json({ error: 'All tracks are already in the playlist' });
    }

    // Clamped into the playlist rather than used raw. The Mongo version shifted
    // by `$inc` from `position` verbatim, so a position past the end left a GAP
    // in the ordering and a non-numeric one wrote `NaN`; positions are
    // `0…n-1` here, which is what `removeTracksFromPlaylist` already assumed.
    const requested = Number(position);
    const insertAt =
      position === undefined || !Number.isFinite(requested)
        ? existing.length
        : Math.max(0, Math.min(Math.trunc(requested), existing.length));

    // The whole playlist in its new order: `assignPlaylistTrackPositions` takes
    // a full order rather than a delta because a unique constraint on
    // `(playlist_id, position)` cannot be shifted in place. Its own doc comment
    // carries the measurement.
    const ordered = [
      ...existing.slice(0, insertAt).map((entry) => entry.trackId),
      ...newTrackIds,
      ...existing.slice(insertAt).map((entry) => entry.trackId),
    ];

    const addedAt = new Date();
    await getDb().transaction(async (tx) => {
      await tx.insert(playlistTracks).values(
        newTrackIds.map((trackId, index) => ({
          playlistId: id,
          trackId,
          addedAt,
          addedBy: userId,
          // Provisional, and rewritten by the next statement. They still have
          // to be distinct from each other and from every existing row for the
          // INSERT itself to pass, which appending past the end guarantees.
          position: existing.length + index,
        }))
      );

      await assignPlaylistTrackPositions(tx, id, ordered);
      await refreshPlaylistStats(tx, id);
    });

    res.status(201).json({
      added: newTrackIds.length,
      skipped: validTrackIds.length - newTrackIds.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/playlists/:id/tracks
 * Remove tracks from playlist (requires auth and edit permission)
 */
export const removeTracksFromPlaylist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = getParam(req, 'id');
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check edit permission
    if (!(await canEditPlaylist(id, userId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { trackIds } = req.body;

    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return res.status(400).json({ error: 'trackIds must be a non-empty array' });
    }

    const removing = trackIds.filter((tid: unknown): tid is string => typeof tid === 'string');
    if (removing.length === 0) {
      return res.json({ removed: 0 });
    }

    const removed = await getDb().transaction(async (tx) => {
      const deleted = await tx
        .delete(playlistTracks)
        .where(and(eq(playlistTracks.playlistId, id), inArray(playlistTracks.trackId, removing)))
        .returning({ trackId: playlistTracks.trackId });

      if (deleted.length > 0) {
        // Close the gaps the deletes left, so positions stay `0…n-1`. Read
        // INSIDE the transaction and after the delete, so it cannot reorder
        // against a stale picture of the playlist.
        const remaining = await tx
          .select({ trackId: playlistTracks.trackId })
          .from(playlistTracks)
          .where(eq(playlistTracks.playlistId, id))
          .orderBy(playlistTracks.position);

        await assignPlaylistTrackPositions(
          tx,
          id,
          remaining.map((row) => row.trackId)
        );
        await refreshPlaylistStats(tx, id);
      }

      return deleted.length;
    });

    res.json({ removed });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/playlists/:id/tracks/reorder
 * Reorder tracks in playlist (requires auth and edit permission)
 */
export const reorderPlaylistTracks = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = getParam(req, 'id');
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check edit permission
    if (!(await canEditPlaylist(id, userId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { trackIds } = req.body;

    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return res.status(400).json({ error: 'trackIds must be a non-empty array' });
    }

    // Validate all track IDs exist in playlist
    const present = (await findPlaylistTracks(id)).map((entry) => entry.trackId);
    const named = new Set(present);
    const invalidTrackIds = trackIds.filter(
      (tid: unknown) => typeof tid !== 'string' || !named.has(tid)
    );
    if (invalidTrackIds.length > 0) {
      return res.status(400).json({
        error: 'Some track IDs are not in the playlist',
        invalidTrackIds,
      });
    }

    const requested: string[] = [...new Set<string>(trackIds)];
    // Any track the request did not name keeps its relative place AFTER the
    // ones it did. The Mongo version left those rows at whatever position they
    // already held, which is only well defined when the request names the whole
    // playlist — and collides with a newly assigned position when it does not.
    const unnamed = new Set(requested);
    const ordered = [...requested, ...present.filter((trackId) => !unnamed.has(trackId))];

    await getDb().transaction(async (tx) => {
      await assignPlaylistTrackPositions(tx, id, ordered);
    });

    res.json({
      reordered: requested.length,
    });
  } catch (error) {
    next(error);
  }
};
