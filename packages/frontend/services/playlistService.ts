import { api } from '@/utils/api';
import {
  playlistSchema,
  type Playlist,
  type UpdatePlaylistRequest,
} from '@syra/shared-types';
import { z } from 'zod';
import { normalizePlaylistImages } from '@/utils/catalogImages';

/**
 * Playlist mutation service.
 *
 * Reads (`getPlaylistById`, `getPlaylistTracks`, `getUserPlaylists`,
 * `createPlaylist`) stay in {@link musicService}; this module owns the four
 * write endpoints that edit an existing playlist. Response shapes are taken
 * from `packages/backend/src/controllers/playlists.controller.ts`, not inferred
 * from the frontend's own types, and every one is Zod-parsed at the boundary so
 * backend drift fails loudly here rather than as `undefined` deep in the UI.
 */

const playlistResponseSchema = playlistSchema.passthrough();

/** `POST /playlists/:id/tracks` → 201. `skipped` counts already-present tracks. */
const addTracksResponseSchema = z.object({
  added: z.number(),
  skipped: z.number(),
}).passthrough();

/** `DELETE /playlists/:id/tracks` → 200. `removed` is the raw `deletedCount`. */
const removeTracksResponseSchema = z.object({
  removed: z.number(),
}).passthrough();

/** `PUT /playlists/:id/tracks/reorder` → 200. */
const reorderTracksResponseSchema = z.object({
  reordered: z.number(),
}).passthrough();

function parsePlaylistResponse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Invalid ${label} response: ${parsed.error.message}`);
  }
  return parsed.data;
}

export interface AddTracksResult {
  /** Tracks actually inserted. */
  added: number;
  /** Tracks the backend ignored because they were already in the playlist. */
  skipped: number;
}

export interface RemoveTracksResult {
  /** Rows actually deleted; ids that weren't in the playlist simply don't count. */
  removed: number;
}

export interface ReorderTracksResult {
  reordered: number;
}

export const playlistService = {
  /**
   * `PUT /playlists/:id` — partial update; only the provided fields change.
   *
   * `coverArt` must already be an uploaded image id (the backend rejects blob:
   * and http(s): values outright), so callers upload first and pass the id.
   */
  async updatePlaylist(playlistId: string, updates: UpdatePlaylistRequest): Promise<Playlist> {
    const response = await api.put<unknown>(`/playlists/${playlistId}`, updates);
    return normalizePlaylistImages(
      parsePlaylistResponse(playlistResponseSchema, response.data, 'update playlist'),
    );
  },

  /**
   * `DELETE /playlists/:id` — owner only; collaborators get a 403.
   *
   * Answers 204 with no body, so there is nothing to parse: a schema here would
   * be asserting a shape the endpoint never sends.
   */
  async deletePlaylist(playlistId: string): Promise<void> {
    await api.delete<unknown>(`/playlists/${playlistId}`);
  },

  /**
   * `POST /playlists/:id/tracks` — appends by default, or inserts at `position`
   * and shifts the rest down.
   *
   * Tracks already in the playlist are skipped rather than duplicated; when
   * EVERY requested track is already present the backend answers 400, so a
   * caller adding a single duplicate track gets a thrown error, not `added: 0`.
   */
  async addTracks(
    playlistId: string,
    trackIds: string[],
    position?: number,
  ): Promise<AddTracksResult> {
    const response = await api.post<unknown>(`/playlists/${playlistId}/tracks`, {
      trackIds,
      ...(position === undefined ? {} : { position }),
    });
    return parsePlaylistResponse(addTracksResponseSchema, response.data, 'add playlist tracks');
  },

  /**
   * `DELETE /playlists/:id/tracks` — removes the given tracks and re-packs the
   * remaining `order` values so no gaps are left behind.
   *
   * This endpoint carries a request BODY, which the `api.delete` wrapper passes
   * through as `data` (HttpService serializes it for every non-GET verb). Ids
   * that aren't in the playlist are silently no-ops, so `removed` can legitimately
   * be lower than `trackIds.length`.
   */
  async removeTracks(playlistId: string, trackIds: string[]): Promise<RemoveTracksResult> {
    const response = await api.delete<unknown>(`/playlists/${playlistId}/tracks`, {
      data: { trackIds },
    });
    return parsePlaylistResponse(removeTracksResponseSchema, response.data, 'remove playlist tracks');
  },

  /**
   * `PUT /playlists/:id/tracks/reorder` — `trackIds` is the full new order.
   *
   * The backend rejects the whole request (400, with `invalidTrackIds`) if any
   * id is not currently in the playlist, so callers must send the complete list
   * rather than a moved subset.
   */
  async reorderTracks(playlistId: string, trackIds: string[]): Promise<ReorderTracksResult> {
    const response = await api.put<unknown>(`/playlists/${playlistId}/tracks/reorder`, {
      trackIds,
    });
    return parsePlaylistResponse(reorderTracksResponseSchema, response.data, 'reorder playlist tracks');
  },
};
