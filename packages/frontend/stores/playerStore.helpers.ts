/**
 * PlayerStore Helper Functions
 * Utility functions for the audio player store
 */

import { Track } from '@syra/shared-types';
import { getApiOrigin, api } from '@/utils/api';
import { AUDIO_URL_PATTERN } from './playerStore.config';

/**
 * Response type for authenticated audio URL endpoint
 */
export interface AudioUrlResponse {
  url: string;
  trackId: string;
  expiresIn: number;
}

/**
 * Extract track ID from audio source URL
 * @param audioUrl - The audio source URL (format: /api/audio/:trackId)
 * @param fallbackTrackId - Fallback track ID if URL parsing fails
 * @returns The extracted track ID
 */
export function extractTrackIdFromUrl(audioUrl: string, fallbackTrackId: string): string {
  const match = audioUrl.match(AUDIO_URL_PATTERN);
  return match ? match[1] : fallbackTrackId;
}

/**
 * Resolve the track ID used to fetch an authenticated (pre-signed) audio URL.
 *
 * Uploaded tracks carry an `audioSource.url` of the form `/api/audio/:trackId`,
 * from which the canonical id is parsed. Tracks without `audioSource` use their
 * own id so the backend stream resolver can decide whether they are playable.
 *
 * @param track - The track to resolve an id for
 * @returns The track ID to request a pre-signed URL for
 */
export function resolveTrackId(track: Track): string {
  if (track.audioSource?.url) {
    return extractTrackIdFromUrl(track.audioSource.url, track.id);
  }
  return track.id;
}

/**
 * Resolve a directly-playable Syra audio URL for legacy uploaded tracks without
 * using provider URLs. Provider streams are resolved exclusively through
 * `/api/stream/:trackId` so user preferences and backend policy are enforced.
 *
 * @param track - The track to resolve a URL for
 * @returns The resolved audio URL, or `undefined` when the track has no
 *   directly-playable source
 */
export function resolveAudioUrlWithFallback(track: Track): string | undefined {
  const sourceUrl = track.audioSource?.url;
  if (!sourceUrl) {
    return undefined;
  }
  if (sourceUrl.startsWith('/')) {
    return `${getApiOrigin()}${sourceUrl}`;
  }
  return sourceUrl;
}

/**
 * Fetch authenticated audio URL (pre-signed S3 URL)
 * @param trackId - The track ID to fetch URL for
 * @returns The authenticated audio URL
 * @throws Error if URL fetch fails and no fallback is available
 */
export async function fetchAuthenticatedAudioUrl(trackId: string): Promise<string> {
  try {
    const response = await api.get<AudioUrlResponse>(`/audio/${trackId}/url`);
    return response.data.url;
  } catch (error) {
    throw new Error(`Failed to fetch authenticated audio URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Calculate track duration from player state or track metadata
 * @param trackDuration - Duration from track metadata
 * @param playerDuration - Duration from player state
 * @param isPlayerLoaded - Whether the player is loaded
 * @returns The calculated duration
 */
export function calculateTrackDuration(
  trackDuration: number | undefined,
  playerDuration: number | undefined,
  isPlayerLoaded: boolean
): number {
  if (trackDuration && trackDuration > 0) {
    return trackDuration;
  }
  if (isPlayerLoaded && playerDuration && playerDuration > 0) {
    return playerDuration;
  }
  return 0;
}

/**
 * Clamp volume value between min and max
 * @param volume - Volume value to clamp
 * @param min - Minimum volume (default: 0)
 * @param max - Maximum volume (default: 1)
 * @returns Clamped volume value
 */
export function clampVolume(volume: number, min: number = 0, max: number = 1): number {
  return Math.max(min, Math.min(max, volume));
}





