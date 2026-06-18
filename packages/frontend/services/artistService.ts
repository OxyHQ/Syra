import { api } from '@/utils/api';
import { Artist, CreateArtistRequest, ArtistDashboard, ArtistInsights, CreateAlbumRequest, Track, Album } from '@syra/shared-types';
import { Platform } from 'react-native';
import { normalizeAlbumImages, normalizeArtistImages, normalizeTrackImages } from '@/utils/catalogImages';
import { createScopedLogger } from '@/utils/logger';

const logger = createScopedLogger('ArtistService');

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('response' in error) {
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === 'object' && 'status' in response) {
      const status = (response as { status?: unknown }).status;
      return typeof status === 'number' ? status : undefined;
    }
  }
  if ('status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

/**
 * Artist API service
 * Handles all artist-related API calls including uploads
 */
export const artistService = {
  /**
   * Register as an artist (create artist profile)
   */
  async registerAsArtist(data: CreateArtistRequest): Promise<Artist> {
    const response = await api.post<Artist>('/artists/register', data);
    return normalizeArtistImages(response.data);
  },

  /**
   * Get current user's artist profile
   * Returns null if user doesn't have an artist profile.
   */
  async getMyArtistProfile(): Promise<Artist | null> {
    try {
      const response = await api.get<Artist | null>('/artists/me');
      if (!response.data) {
        return null;
      }
      return normalizeArtistImages(response.data);
    } catch (error: unknown) {
      // Check for 404 or any error status
      const status = getHttpStatus(error);
      if (status === 404) {
        // User doesn't have an artist profile - this is expected, not an error
        // Silently return null without logging
        return null;
      }
      // Log other errors but don't throw - return null to indicate no profile
      logger.warn('Error fetching artist profile', { error });
      return null;
    }
  },

  /**
   * Upload a track with audio file
   */
  async uploadTrack(
    audioFile: { uri: string; name?: string; type?: string },
    data: {
      title: string;
      artistId: string;
      albumId?: string;
      coverArt?: string;
      genre?: string[];
      isExplicit?: boolean;
      duration: number;
    },
    onProgress?: (progress: number) => void
  ): Promise<Track> {
    const formData = new FormData();

    // Add audio file
    const fileUri = audioFile.uri;
    const fileName = audioFile.name || `audio-${Date.now()}.mp3`;
    const fileType = audioFile.type || 'audio/mpeg';

    if (Platform.OS === 'web') {
      // Web: fetch the file and create a File object
      const response = await fetch(fileUri);
      const blob = await response.blob();
      formData.append('audioFile', blob, fileName);
    } else {
      // React Native: append the file by URI. RN's FormData accepts a
      // { uri, name, type } descriptor, which is not part of the DOM
      // FormData.append signature, so it goes through a typed Blob view.
      const rnFilePart = { uri: fileUri, name: fileName, type: fileType } as unknown as Blob;
      formData.append('audioFile', rnFilePart, fileName);
    }

    // Add other form fields
    formData.append('title', data.title);
    formData.append('artistId', data.artistId);
    if (data.albumId) {
      formData.append('albumId', data.albumId);
    }
    if (data.coverArt) {
      formData.append('coverArt', data.coverArt);
    }
    if (data.genre) {
      if (Array.isArray(data.genre)) {
        data.genre.forEach((g) => formData.append('genre', g));
      } else {
        formData.append('genre', data.genre);
      }
    }
    if (data.isExplicit !== undefined) {
      formData.append('isExplicit', String(data.isExplicit));
    }
    formData.append('duration', String(data.duration));

    onProgress?.(0);
    const response = await api.post<Track>('/tracks/upload', formData);
    onProgress?.(100);
    return normalizeTrackImages(response.data);
  },

  /**
   * Create an album
   */
  async createAlbum(data: CreateAlbumRequest): Promise<Album> {
    const response = await api.post<Album>('/albums', data);
    return normalizeAlbumImages(response.data);
  },

  /**
   * Get artist dashboard data
   */
  async getArtistDashboard(): Promise<ArtistDashboard> {
    const response = await api.get<ArtistDashboard>('/artists/me/dashboard');
    return {
      ...response.data,
      artist: normalizeArtistImages(response.data.artist),
    };
  },

  /**
   * Get artist insights/analytics
   */
  async getArtistInsights(period?: '7days' | '30days' | 'alltime'): Promise<ArtistInsights> {
    const response = await api.get<ArtistInsights>('/artists/me/insights', { period });
    return response.data;
  },
};
