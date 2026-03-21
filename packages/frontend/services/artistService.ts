import { api, authenticatedClient, getApiOrigin } from '@/utils/api';
import { Artist, CreateArtistRequest, ArtistDashboard, ArtistInsights, CreateAlbumRequest, Track, Album } from '@syra/shared-types';
import { Platform } from 'react-native';

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
    return response.data;
  },

  /**
   * Get current user's artist profile
   * Returns null if user doesn't have an artist profile (404) - this is expected and not an error
   */
  async getMyArtistProfile(): Promise<Artist | null> {
    try {
      const response = await api.get<Artist>('/artists/me');
      return response.data;
    } catch (error: any) {
      // Check for 404 or any error status
      const status = error?.response?.status || error?.status;
      if (status === 404) {
        // User doesn't have an artist profile - this is expected, not an error
        // Silently return null without logging
        return null;
      }
      // Log other errors but don't throw - return null to indicate no profile
      console.warn('[artistService] Error fetching artist profile:', error);
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
      // React Native: use the URI directly
      formData.append('audioFile', {
        uri: fileUri,
        name: fileName,
        type: fileType,
      } as any);
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

    // Use authenticatedClient directly for file uploads
    const response = await authenticatedClient.post('/tracks/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: onProgress
        ? (progressEvent) => {
            if (progressEvent.total) {
              const progress = (progressEvent.loaded / progressEvent.total) * 100;
              onProgress(progress);
            }
          }
        : undefined,
    });

    return response.data;
  },

  /**
   * Create an album
   */
  async createAlbum(data: CreateAlbumRequest): Promise<Album> {
    const response = await api.post<Album>('/albums', data);
    return response.data;
  },

  /**
   * Get artist dashboard data
   */
  async getArtistDashboard(): Promise<ArtistDashboard> {
    const response = await api.get<ArtistDashboard>('/artists/me/dashboard');
    return response.data;
  },

  /**
   * Get artist insights/analytics
   */
  async getArtistInsights(period?: '7days' | '30days' | 'alltime'): Promise<ArtistInsights> {
    const response = await api.get<ArtistInsights>('/artists/me/insights', { period });
    return response.data;
  },
};

