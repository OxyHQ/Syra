import { z } from 'zod';
import { timestampsSchema } from './common';
import {
  catalogSourceSchema,
  catalogImageSizesSchema,
  externalIdsSchema,
  sourceProvenanceSchema,
  trackSchema,
} from './track';

export const playlistVisibilitySchema = z.enum(['public', 'private', 'unlisted']);
export type PlaylistVisibility = z.infer<typeof playlistVisibilitySchema>;
export const PlaylistVisibility = {
  PUBLIC: 'public' as const,
  PRIVATE: 'private' as const,
  UNLISTED: 'unlisted' as const,
};

export const playlistCollaboratorSchema = z.object({
  oxyUserId: z.string(),
  username: z.string(),
  role: z.enum(['owner', 'editor', 'viewer']),
  addedAt: z.string(),
});
export type PlaylistCollaborator = z.infer<typeof playlistCollaboratorSchema>;

export const playlistSchema = timestampsSchema.extend({
  id: z.string(),
  _id: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  ownerOxyUserId: z.string(),
  ownerUsername: z.string(),
  coverArt: z.string().optional(),
  coverArtSizes: catalogImageSizesSchema.optional(),
  visibility: playlistVisibilitySchema,
  trackCount: z.number(),
  totalDuration: z.number(),
  followers: z.number().optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  collaborators: z.array(playlistCollaboratorSchema).optional(),
  source: catalogSourceSchema.optional(),
  externalIds: externalIdsSchema.optional(),
  sources: z.array(sourceProvenanceSchema).optional(),
});
export type Playlist = z.infer<typeof playlistSchema>;

export const playlistTrackSchema = z.object({
  trackId: z.string(),
  addedAt: z.string(),
  addedBy: z.string().optional(),
  order: z.number(),
});
export type PlaylistTrack = z.infer<typeof playlistTrackSchema>;

export const playlistWithTracksSchema = playlistSchema.extend({
  tracks: z.array(trackSchema),
  playlistTracks: z.array(playlistTrackSchema),
});
export type PlaylistWithTracks = z.infer<typeof playlistWithTracksSchema>;

export const createPlaylistRequestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  coverArt: z.string().optional(),
  visibility: playlistVisibilitySchema.optional(),
});
export type CreatePlaylistRequest = z.infer<typeof createPlaylistRequestSchema>;

export const updatePlaylistRequestSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  coverArt: z.string().optional(),
  visibility: playlistVisibilitySchema.optional(),
});
export type UpdatePlaylistRequest = z.infer<typeof updatePlaylistRequestSchema>;

export const addTracksToPlaylistRequestSchema = z.object({
  playlistId: z.string(),
  trackIds: z.array(z.string()),
  position: z.number().optional(),
});
export type AddTracksToPlaylistRequest = z.infer<typeof addTracksToPlaylistRequestSchema>;

export const removeTracksFromPlaylistRequestSchema = z.object({
  playlistId: z.string(),
  trackIds: z.array(z.string()),
});
export type RemoveTracksFromPlaylistRequest = z.infer<typeof removeTracksFromPlaylistRequestSchema>;

export const reorderPlaylistTracksRequestSchema = z.object({
  playlistId: z.string(),
  trackIds: z.array(z.string()),
});
export type ReorderPlaylistTracksRequest = z.infer<typeof reorderPlaylistTracksRequestSchema>;

/**
 * Request-body schemas for the `/:id/tracks` routes, where the playlist id is a
 * path param rather than a body field. Used by the backend `validate()`
 * middleware so controllers can trust `req.body`.
 */
export const addTracksToPlaylistBodySchema = addTracksToPlaylistRequestSchema.omit({ playlistId: true }).extend({
  trackIds: z.array(z.string()).min(1),
});
export type AddTracksToPlaylistBody = z.infer<typeof addTracksToPlaylistBodySchema>;

export const removeTracksFromPlaylistBodySchema = z.object({
  trackIds: z.array(z.string()).min(1),
});
export type RemoveTracksFromPlaylistBody = z.infer<typeof removeTracksFromPlaylistBodySchema>;

export const reorderPlaylistTracksBodySchema = z.object({
  trackIds: z.array(z.string()).min(1),
});
export type ReorderPlaylistTracksBody = z.infer<typeof reorderPlaylistTracksBodySchema>;
