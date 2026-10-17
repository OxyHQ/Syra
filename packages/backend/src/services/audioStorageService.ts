import type { Track } from '@syra/shared-types';
import {
  audioObjectExists,
  deleteAudioObject,
  getS3AudioKey,
  openAudioObject,
  presignAudioObject,
  putSourceAudio,
  statAudioObject,
  type AudioOwner,
  type AudioRange,
} from './oxyFiles/audioStorage';
import { logger } from '../utils/logger';
import type { Readable } from 'stream';

/**
 * Audio Storage Service
 * High-level abstraction for audio file storage operations
 */

/**
 * Minimal subset of a track needed to address its audio in S3. Derived from the
 * shared `Track` type so it stays in sync, while letting callers pass any value
 * (e.g. a partial row projection) that carries these fields without
 * matching the full `Track` shape.
 */
export type TrackAudioRef = Pick<Track, 'id' | 'artistId' | 'albumId' | 'title' | 'audioSource'> & {
  /**
   * `tracks.audio_source_key`: where the original was WRITTEN. Server-only, so
   * not on the shared DTO. Pass it whenever the row is at hand — the derived
   * key is only right while the track keeps the artist and album it was
   * uploaded under.
   */
  audioSourceKey?: string | null;
};

/**
 * The bucket key of a track's original: the one recorded at upload, else the
 * one its CURRENT artist and album derive (right for a track that has kept
 * both, and the only answer for one not yet backfilled).
 */
export function getTrackS3Key(track: TrackAudioRef): string {
  if (track.audioSourceKey) return track.audioSourceKey;
  if (!track.audioSource) {
    throw new Error(`Track ${track.id} has no audio source`);
  }
  const format = track.audioSource.format || 'mp3';
  return getS3AudioKey(track.id, track.artistId, track.albumId, format);
}

/**
 * Upload audio file to S3 for a track
 */
export async function uploadTrackAudio(
  track: TrackAudioRef,
  audioFile: Buffer | Readable | string,
  /** Whose upload this is — the owner the audio gets once it moves to Oxy Files. */
  owner: AudioOwner,
): Promise<string> {
  if (!track.audioSource) {
    throw new Error(`Track ${track.id} has no audio source`);
  }
  const key = getTrackS3Key(track);
  const contentType = `audio/${track.audioSource.format || 'mpeg'}`;

  await putSourceAudio(key, audioFile, {
    owner,
    contentType,
    metadata: {
      trackId: track.id,
      artistId: track.artistId,
      albumId: track.albumId || '',
      title: track.title,
    },
  });

  logger.info(`[AudioStorageService] Uploaded audio for track: ${track.id}`);
  return key;
}

/**
 * Get pre-signed URL for streaming a track
 * Cached for 5-10 minutes to reduce S3 API calls
 */
const presignedUrlCache = new Map<string, { url: string; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getTrackStreamUrl(track: TrackAudioRef): Promise<string> {
  const key = getTrackS3Key(track);

  // Check cache
  const cached = presignedUrlCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  // Generate new pre-signed URL (1 hour expiration)
  const url = await presignAudioObject(key, 3600);

  // Cache it
  presignedUrlCache.set(key, {
    url,
    expiresAt: Date.now() + CACHE_TTL,
  });

  return url;
}

/**
 * Stream audio file from S3 with Range Request support
 */
export async function streamTrackAudio(
  track: TrackAudioRef,
  options: AudioRange = {},
): Promise<{
  stream: Readable;
  contentLength: number;
  contentType?: string;
  contentRange?: string;
}> {
  const key = getTrackS3Key(track);
  return openAudioObject(key, options);
}

/**
 * Get track audio metadata from S3
 */
export async function getTrackAudioMetadata(track: TrackAudioRef) {
  const key = getTrackS3Key(track);
  return statAudioObject(key);
}

/**
 * Check if track audio exists in S3
 */
export async function trackAudioExists(track: TrackAudioRef): Promise<boolean> {
  const key = getTrackS3Key(track);
  return audioObjectExists(key);
}

/**
 * Delete track audio from S3
 */
export async function deleteTrackAudio(track: TrackAudioRef): Promise<void> {
  const key = getTrackS3Key(track);
  await deleteAudioObject(key);
  logger.info(`[AudioStorageService] Deleted audio for track: ${track.id}`);
}

/**
 * Clear presigned URL cache (useful for testing or cache invalidation)
 */
export function clearPresignedUrlCache(): void {
  presignedUrlCache.clear();
}
