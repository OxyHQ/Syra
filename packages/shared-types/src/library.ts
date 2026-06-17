import { z } from 'zod';
import { timestampsSchema } from './common';
import { trackSchema } from './track';
import { albumSchema } from './album';
import { artistSchema } from './artist';
import { playlistSchema } from './playlist';

export const userLibrarySchema = timestampsSchema.extend({
  oxyUserId: z.string(),
  likedTracks: z.array(z.string()),
  savedAlbums: z.array(z.string()),
  followedArtists: z.array(z.string()),
  playlists: z.array(z.string()),
});
export type UserLibrary = z.infer<typeof userLibrarySchema>;

export const likedTracksSchema = z.object({
  tracks: z.array(trackSchema),
  total: z.number(),
  oxyUserId: z.string(),
});
export type LikedTracks = z.infer<typeof likedTracksSchema>;

export const savedAlbumsSchema = z.object({
  albums: z.array(albumSchema),
  total: z.number(),
  oxyUserId: z.string(),
});
export type SavedAlbums = z.infer<typeof savedAlbumsSchema>;

export const followedArtistsSchema = z.object({
  artists: z.array(artistSchema),
  total: z.number(),
  oxyUserId: z.string(),
});
export type FollowedArtists = z.infer<typeof followedArtistsSchema>;

export const userPlaylistsSchema = z.object({
  playlists: z.array(playlistSchema),
  total: z.number(),
  oxyUserId: z.string(),
});
export type UserPlaylists = z.infer<typeof userPlaylistsSchema>;

export const likeTrackRequestSchema = z.object({
  trackId: z.string(),
});
export type LikeTrackRequest = z.infer<typeof likeTrackRequestSchema>;

export const unlikeTrackRequestSchema = z.object({
  trackId: z.string(),
});
export type UnlikeTrackRequest = z.infer<typeof unlikeTrackRequestSchema>;

export const saveAlbumRequestSchema = z.object({
  albumId: z.string(),
});
export type SaveAlbumRequest = z.infer<typeof saveAlbumRequestSchema>;

export const unsaveAlbumRequestSchema = z.object({
  albumId: z.string(),
});
export type UnsaveAlbumRequest = z.infer<typeof unsaveAlbumRequestSchema>;
