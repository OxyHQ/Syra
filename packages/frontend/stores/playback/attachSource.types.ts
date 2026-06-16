import type { AudioPlayer } from 'expo-audio';
import type { StreamResolution } from '@/services/streamService';

// ── Shared contract ───────────────────────────────────────────────────────────

export interface AttachResult {
  /**
   * Tear down any resources allocated for this attachment (e.g. hls.js
   * instance). Must be called before attaching a new source or removing the
   * player. Safe to call multiple times.
   */
  detach: () => void;
}

/**
 * Attach a stream resolution to a player instance.
 *
 * Platform implementations:
 *  - `attachSource.native.ts` — uses `player.replace()` for all modes;
 *    AVPlayer/ExoPlayer handle HLS+AES-128 natively.
 *  - `attachSource.web.ts`    — picks the correct mode via `pickPlaybackMode`;
 *    `progressive`/`native` use `player.replace()`; `hlsjs` requires the
 *    larger raw-HTMLAudioElement fork (not yet implemented — throws).
 */
export type AttachSourceFn = (
  player: AudioPlayer,
  resolution: StreamResolution,
) => AttachResult;
