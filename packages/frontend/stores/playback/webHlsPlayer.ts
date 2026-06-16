/**
 * Default (tsc / non-Metro) export for the web HLS player.
 *
 * Metro resolves `.web.ts` at runtime (web platform); `.native.ts` does not
 * exist because native HLS is handled by expo-audio (AVPlayer / ExoPlayer),
 * not this engine. This file exists only so that:
 *  - TypeScript (`tsc --noEmit`) can resolve the import from `playerStore.ts`
 *    without platform-extension awareness.
 *  - Non-Metro tooling (type checkers, jest via jest-expo) gets a valid module.
 *
 * The native Metro bundle never loads this file — the store's engine-selection
 * logic passes only `'progressive'` or `'native'` mode on iOS/Android, so
 * `createWebHlsPlayer` is never called in those bundles.
 *
 * Do NOT import hls.js or any DOM-only module here.
 */
import type { PlayerEngine } from './playerEngine';

/** @see webHlsPlayer.web.ts for the runtime implementation */
export function createWebHlsPlayer(_url: string): PlayerEngine {
  throw new Error('createWebHlsPlayer is web-only and must not be called on native');
}
