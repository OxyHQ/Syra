/**
 * Web implementation of attachSource.
 *
 * The STORE is responsible for choosing the correct engine before calling
 * attachSource (expo-audio's AudioPlayer for progressive/native; WebHlsPlayer
 * for hlsjs). By the time attachSource is called the engine is already the
 * right type, so all three modes reduce to player.replace() — the engine
 * internalises the hls.js logic.
 *
 * For `hlsjs` mode the store passes a WebHlsPlayer whose replace() calls
 * hls.loadSource() rather than setting audio.src directly.
 */
import type { PlayerEngine } from './playerEngine';
import type { StreamResolution } from '@/services/streamService';
import type { AttachResult } from './attachSource.types';

export function attachSource(player: PlayerEngine, resolution: StreamResolution): AttachResult {
  player.replace({ uri: resolution.url });
  return { detach: () => {} };
}
