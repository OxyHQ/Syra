import type { StreamResolution } from '@/services/streamService';
import type { AttachResult } from './attachSource.types';
import type { PlayerEngine } from './playerEngine';

/**
 * Native (iOS / Android) implementation.
 *
 * AVPlayer (iOS) and ExoPlayer (Android) handle HLS+AES-128 natively, so we
 * always use `player.replace()` regardless of stream type. No additional
 * resources are allocated — `detach` is a no-op.
 */
export function attachSource(player: PlayerEngine, resolution: StreamResolution): AttachResult {
  player.replace({ uri: resolution.url });
  return { detach: () => {} };
}
