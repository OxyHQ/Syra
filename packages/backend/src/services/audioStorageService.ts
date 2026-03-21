import { Track } from '@syra/shared-types';
import { getS3AudioKey } from '../config/s3.config';
import {
  uploadToS3,
  getPresignedUrl,
  streamFromS3,
  getObjectMetadata,
  deleteFromS3,
  objectExists,
  S3StreamOptions,
} from './s3Service';
import { logger } from '../utils/logger';
import { Readable } from 'stream';

/**
 * Audio Storage Service
 * High-level abstraction for audio file storage operations
 */

/**
 * Get S3 key for a track
 */
export function getTrackS3Key(track: Track): string {
  const format = track.audioSource.format || 'mp3';
  return getS3AudioKey(
    track.id,
    track.artistId,
    track.albumId,
    format
  );
}

/**
 * Upload audio file to S3 for a track
 */
export async function uploadTrackAudio(
  track: Track,
  audioFile: Buffer | Readable | string
): Promise<string> {
  const key = getTrackS3Key(track);
  const contentType = `audio/${track.audioSource.format || 'mpeg'}`;

  await uploadToS3(key, audioFile, {
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

export async function getTrackStreamUrl(track: Track): Promise<string> {
  const key = getTrackS3Key(track);
  
  // Check cache
  const cached = presignedUrlCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  // Generate new pre-signed URL (1 hour expiration)
  const url = await getPresignedUrl(key, 3600);
  
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
  track: Track,
  options: S3StreamOptions = {}
): Promise<{
  stream: Readable;
  contentLength: number;
  contentType?: string;
  contentRange?: string;
}> {
  const key = getTrackS3Key(track);
  return streamFromS3(key, options);
}

/**
 * Get track audio metadata from S3
 */
export async function getTrackAudioMetadata(track: Track) {
  const key = getTrackS3Key(track);
  return getObjectMetadata(key);
}

/**
 * Check if track audio exists in S3
 */
export async function trackAudioExists(track: Track): Promise<boolean> {
  const key = getTrackS3Key(track);
  return objectExists(key);
}

/**
 * Delete track audio from S3
 */
export async function deleteTrackAudio(track: Track): Promise<void> {
  const key = getTrackS3Key(track);
  await deleteFromS3(key);
  logger.info(`[AudioStorageService] Deleted audio for track: ${track.id}`);
}

/**
 * Clear presigned URL cache (useful for testing or cache invalidation)
 */
export function clearPresignedUrlCache(): void {
  presignedUrlCache.clear();
}






