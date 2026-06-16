import type { StreamResolution } from '@/services/streamService';
import type { PlayerEngine } from './playerEngine';

// ── Shared contract ───────────────────────────────────────────────────────────

export interface AttachResult {
  /**
   * Tear down any resources allocated for this attachment. Must be called
   * before attaching a new source or removing the player. Safe to call
   * multiple times.
   */
  detach: () => void;
}

/**
 * Attach a stream resolution to a player engine.
 *
 * Platform implementations:
 *  - `attachSource.native.ts` — `player.replace()` for all modes.
 *  - `attachSource.web.ts`    — `player.replace()` for all modes; the store
 *    selects the engine (expo-audio vs WebHlsPlayer) before calling attachSource,
 *    so the engine internalises any hls.js wiring.
 */
export type AttachSourceFn = (
  player: PlayerEngine,
  resolution: StreamResolution,
) => AttachResult;
