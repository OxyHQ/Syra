import { Platform } from 'react-native';
import { z } from 'zod';
import {
  albumSchema,
  trackSchema,
  type Album,
  type CreateAlbumRequest,
  type Track,
} from '@syra/shared-types';
import { api } from '@/utils/api';

const trackResponseSchema = trackSchema.passthrough();
const albumResponseSchema = albumSchema.passthrough();
const createAlbumResponseSchema = albumResponseSchema;
const artistAlbumsResponseSchema = z.object({ albums: z.array(albumResponseSchema) }).passthrough();

function parse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid ${label} response: ${result.error.message}`);
  }
  return result.data;
}

export interface TrackAudioFile {
  uri: string;
  name?: string;
  type?: string;
  /** Present on web when the file came from a DOM/document picker. */
  file?: File;
}

export interface UploadTrackMetadata {
  title: string;
  artistId: string;
  albumId?: string;
  /** Cover art as an uploaded image id (MongoDB ObjectId), never a URL/blob. */
  coverArt?: string;
  genre?: string[];
  isExplicit?: boolean;
  /** Duration in seconds (required, must be > 0). */
  duration: number;
}

/**
 * Studio music API service.
 *
 * `uploadTrack` posts multipart form data with the audio under the `audioFile`
 * field (multer `.single('audioFile')` in the backend tracks controller); the
 * track is created with `status: 'processing'` and transitions to `ready` once
 * HLS ingest finishes. Web sends the picked `File`/blob, native sends the RN
 * `{ uri, name, type }` descriptor — the same universal pattern as
 * `episodeService.uploadEpisode`.
 */
export const musicService = {
  async uploadTrack(audioFile: TrackAudioFile, metadata: UploadTrackMetadata): Promise<Track> {
    const formData = new FormData();

    const fileName = audioFile.name || `track-${Date.now()}.mp3`;
    const fileType = audioFile.type || 'audio/mpeg';

    if (Platform.OS === 'web') {
      // Web: prefer the picked File; otherwise fetch the blob URL.
      const blob = audioFile.file ?? (await (await fetch(audioFile.uri)).blob());
      formData.append('audioFile', blob, fileName);
    } else {
      // React Native FormData accepts a { uri, name, type } descriptor, which is
      // not part of the DOM FormData.append signature, so it goes through a
      // typed Blob view.
      const rnFilePart = { uri: audioFile.uri, name: fileName, type: fileType } as unknown as Blob;
      formData.append('audioFile', rnFilePart, fileName);
    }

    formData.append('title', metadata.title);
    formData.append('artistId', metadata.artistId);
    if (metadata.albumId) formData.append('albumId', metadata.albumId);
    if (metadata.coverArt) formData.append('coverArt', metadata.coverArt);
    // The backend reads `genre` as a repeated field into a string[].
    if (metadata.genre?.length) {
      for (const g of metadata.genre) formData.append('genre', g);
    }
    if (metadata.isExplicit !== undefined) formData.append('isExplicit', String(metadata.isExplicit));
    formData.append('duration', String(metadata.duration));

    const response = await api.post<unknown>('/tracks/upload', formData);
    return parse(trackResponseSchema, response.data, 'track upload');
  },

  /** Create an album (cover art required as an uploaded image id). */
  async createAlbum(input: CreateAlbumRequest): Promise<Album> {
    const response = await api.post<unknown>('/albums', input);
    return parse(createAlbumResponseSchema, response.data, 'album creation');
  },

  /** Albums belonging to an artist (used by the upload screen's album picker). */
  async getMyAlbums(artistId: string): Promise<Album[]> {
    const response = await api.get<unknown>(`/artists/${artistId}/albums`);
    return parse(artistAlbumsResponseSchema, response.data, 'artist albums').albums;
  },

  /** A single track — polled after upload to observe the ingest status. */
  async getTrack(id: string): Promise<Track> {
    const response = await api.get<unknown>(`/tracks/${id}`);
    return parse(trackResponseSchema, response.data, 'track');
  },
};
