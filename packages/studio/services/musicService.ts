import { z } from 'zod';
import {
  albumSchema,
  trackSchema,
  type Album,
  type CreateAlbumRequest,
  type Track,
} from '@syra/shared-types';
import { api } from '@/utils/api';
import { uploadAudioDirect } from '@/services/directAudioUpload';

/**
 * Creating the track waits on the server reading the whole file back (ffprobe,
 * the tags) before it answers, so the client default would abort a large one.
 */
const UPLOAD_COMPLETE_TIMEOUT_MS = 10 * 60 * 1000;

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
  /** Cover art as an uploaded image id, never a URL/blob. */
  coverArt?: string;
  genre?: string[];
  isExplicit?: boolean;
}

/**
 * Studio music API service.
 *
 * `uploadTrack` sends the audio straight to storage (`uploadAudioDirect` — the
 * API refuses request bodies over 100 MB and a track may be 200 MB), then
 * creates the track by `uploadId` at the same route as always; the track is
 * created with `status: 'processing'` and transitions to `ready` once HLS ingest
 * finishes.
 *
 * Duration is deliberately absent from the payload: the backend measures it with
 * ffprobe from the uploaded file, so a client value would be ignored anyway.
 */
export const musicService = {
  async uploadTrack(
    audioFile: TrackAudioFile,
    metadata: UploadTrackMetadata,
    onProgress?: (fraction: number) => void,
  ): Promise<Track> {
    const upload = await uploadAudioDirect(
      'track',
      {
        uri: audioFile.uri,
        name: audioFile.name || `track-${Date.now()}.mp3`,
        mimeType: audioFile.type || 'audio/mpeg',
        file: audioFile.file,
      },
      onProgress,
    );

    const response = await api.post<unknown>(
      '/tracks/upload',
      {
        ...upload,
        title: metadata.title,
        artistId: metadata.artistId,
        ...(metadata.albumId ? { albumId: metadata.albumId } : {}),
        ...(metadata.coverArt ? { coverArt: metadata.coverArt } : {}),
        ...(metadata.genre?.length ? { genre: metadata.genre } : {}),
        ...(metadata.isExplicit !== undefined ? { isExplicit: metadata.isExplicit } : {}),
      },
      { timeout: UPLOAD_COMPLETE_TIMEOUT_MS },
    );
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
