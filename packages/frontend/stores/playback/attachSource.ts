/**
 * Default (tsc / non-Metro) export — identical to the native implementation.
 *
 * Metro resolves `.native.ts` (iOS/Android) or `.web.ts` (web) over this file
 * at runtime. This file exists only so that:
 *  - TypeScript (`tsc --noEmit`) can resolve the import from `playerStore.ts`
 *    without platform-extension awareness.
 *  - Non-Metro tooling (test runners, type checkers) get a valid module.
 *
 * Do NOT import platform-only modules here.
 */
import type { StreamResolution } from '@/services/streamService';
import type { AttachResult } from './attachSource.types';
import type { PlayerEngine } from './playerEngine';

/** @see attachSource.native.ts / attachSource.web.ts for runtime implementations */
export function attachSource(player: PlayerEngine, resolution: StreamResolution): AttachResult {
  player.replace({ uri: resolution.url });
  return { detach: () => {} };
}
