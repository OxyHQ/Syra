import type { AudioPlayer } from 'expo-audio';
import type { StreamResolution } from '@/services/streamService';
import type { AttachResult } from './attachSource.types';

/**
 * Native (iOS / Android) implementation.
 *
 * AVPlayer (iOS) and ExoPlayer (Android) both handle HLS+AES-128 natively, so
 * we always use `player.replace()` regardless of stream type. No additional
 * resources are allocated — `detach` is a no-op.
 */
export function attachSource(player: AudioPlayer, resolution: StreamResolution): AttachResult {
  player.replace({ uri: resolution.url });
  return { detach: () => {} };
}
