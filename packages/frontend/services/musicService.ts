import { api } from '@/utils/api';
import {
  albumSchema,
  artistSchema,
  playlistSchema,
  trackSchema,
  type Album,
  type Artist,
  type Playlist,
  type Track,
} from '@syra/shared-types';
import { z } from 'zod';
import {
  normalizeAlbumImages,
  normalizeArtistImages,
  normalizePlaylistImages,
  normalizeTrackImages,
} from '@/utils/catalogImages';

const trackResponseSchema = trackSchema.passthrough();
const albumResponseSchema = albumSchema.passthrough();
const artistResponseSchema = artistSchema.passthrough();
const playlistResponseSchema = playlistSchema.passthrough();

const tracksResponseSchema = z.object({
  tracks: z.array(trackResponseSchema),
  total: z.number(),
  hasMore: z.boolean(),
}).passthrough();
const albumsResponseSchema = z.object({
  albums: z.array(albumResponseSchema),
  total: z.number(),
  hasMore: z.boolean(),
}).passthrough();
const artistsResponseSchema = z.object({
  artists: z.array(artistResponseSchema),
  total: z.number(),
  hasMore: z.boolean(),
}).passthrough();
const albumTracksResponseSchema = z.object({
  tracks: z.array(trackResponseSchema),
}).passthrough();
const artistAlbumsResponseSchema = z.object({
  albums: z.array(albumResponseSchema),
}).passthrough();
const playlistTracksResponseSchema = z.object({
  tracks: z.array(trackResponseSchema),
  total: z.number(),
}).passthrough();
const playlistsResponseSchema = z.object({
  playlists: z.array(playlistResponseSchema),
  total: z.number(),
}).passthrough();
const successResponseSchema = z.object({
  success: z.boolean(),
}).passthrough();

function parseMusicResponse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Invalid ${label} response: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Music API service
 * Handles all music-related API calls
 * Catalog reads use the linked Oxy client so the backend can apply
 * session-scoped playback preferences while guests still receive public data.
 */
export const musicService = {
  // Tracks
  async getTracks(params?: { limit?: number; offset?: number }): Promise<{ tracks: Track[]; total: number; hasMore: boolean }> {
    const response = await api.get<unknown>('/tracks', params);
    const data = parseMusicResponse(tracksResponseSchema, response.data, 'tracks');
    return { ...data, tracks: data.tracks.map(normalizeTrackImages) };
  },

  async getTrackById(id: string): Promise<Track> {
    const response = await api.get<unknown>(`/tracks/${id}`);
    return normalizeTrackImages(parseMusicResponse(trackResponseSchema, response.data, 'track'));
  },

  async searchTracks(query: string, params?: { limit?: number; offset?: number }): Promise<{ tracks: Track[]; total: number; hasMore: boolean }> {
    const response = await api.get<unknown>('/tracks/search', { q: query, ...params });
    const data = parseMusicResponse(tracksResponseSchema, response.data, 'track search');
    return { ...data, tracks: data.tracks.map(normalizeTrackImages) };
  },

  // Albums
  async getAlbums(params?: { limit?: number; offset?: number }): Promise<{ albums: Album[]; total: number; hasMore: boolean }> {
    const response = await api.get<unknown>('/albums', params);
    const data = parseMusicResponse(albumsResponseSchema, response.data, 'albums');
    return { ...data, albums: data.albums.map(normalizeAlbumImages) };
  },

  async getAlbumById(id: string): Promise<Album> {
    const response = await api.get<unknown>(`/albums/${id}`);
    return normalizeAlbumImages(parseMusicResponse(albumResponseSchema, response.data, 'album'));
  },

  async getAlbumTracks(albumId: string): Promise<{ tracks: Track[] }> {
    const response = await api.get<unknown>(`/albums/${albumId}/tracks`);
    const data = parseMusicResponse(albumTracksResponseSchema, response.data, 'album tracks');
    return { ...data, tracks: data.tracks.map(normalizeTrackImages) };
  },

  // Artists
  async getArtists(params?: { limit?: number; offset?: number }): Promise<{ artists: Artist[]; total: number; hasMore: boolean }> {
    const response = await api.get<unknown>('/artists', params);
    const data = parseMusicResponse(artistsResponseSchema, response.data, 'artists');
    return { ...data, artists: data.artists.map(normalizeArtistImages) };
  },

  async getArtistById(id: string): Promise<Artist> {
    const response = await api.get<unknown>(`/artists/${id}`);
    return normalizeArtistImages(parseMusicResponse(artistResponseSchema, response.data, 'artist'));
  },

  async getArtistAlbums(artistId: string): Promise<{ albums: Album[] }> {
    const response = await api.get<unknown>(`/artists/${artistId}/albums`);
    const data = parseMusicResponse(artistAlbumsResponseSchema, response.data, 'artist albums');
    return { ...data, albums: data.albums.map(normalizeAlbumImages) };
  },

  async getArtistTracks(artistId: string, params?: { limit?: number; offset?: number }): Promise<{ tracks: Track[]; total: number; hasMore: boolean }> {
    const response = await api.get<unknown>(`/artists/${artistId}/tracks`, params);
    const data = parseMusicResponse(tracksResponseSchema, response.data, 'artist tracks');
    return { ...data, tracks: data.tracks.map(normalizeTrackImages) };
  },

  async followArtist(artistId: string): Promise<{ success: boolean }> {
    const response = await api.post<unknown>(`/artists/${artistId}/follow`);
    return parseMusicResponse(successResponseSchema, response.data, 'follow artist');
  },

  async unfollowArtist(artistId: string): Promise<{ success: boolean }> {
    const response = await api.post<unknown>(`/artists/${artistId}/unfollow`);
    return parseMusicResponse(successResponseSchema, response.data, 'unfollow artist');
  },

  // Playlists
  async getPlaylistById(id: string): Promise<Playlist> {
    const response = await api.get<unknown>(`/playlists/${id}`);
    return normalizePlaylistImages(parseMusicResponse(playlistResponseSchema, response.data, 'playlist'));
  },

  async getPlaylistTracks(playlistId: string): Promise<{ tracks: Track[]; total: number }> {
    const response = await api.get<unknown>(`/playlists/${playlistId}/tracks`);
    const data = parseMusicResponse(playlistTracksResponseSchema, response.data, 'playlist tracks');
    return { ...data, tracks: data.tracks.map(normalizeTrackImages) };
  },

  async getUserPlaylists(): Promise<{ playlists: Playlist[]; total: number }> {
    const response = await api.get<unknown>('/playlists');
    const data = parseMusicResponse(playlistsResponseSchema, response.data, 'playlists');
    return { ...data, playlists: data.playlists.map(normalizePlaylistImages) };
  },

  async createPlaylist(data: { 
    name: string; 
    description?: string; 
    coverArt?: string; 
    isPublic?: boolean;
    visibility?: string;
  }): Promise<Playlist> {
    const response = await api.post<unknown>('/playlists', data);
    return normalizePlaylistImages(parseMusicResponse(playlistResponseSchema, response.data, 'create playlist'));
  },
};
