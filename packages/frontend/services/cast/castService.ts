/**
 * Default (tsc / non-Metro) cast service — a no-op controller.
 *
 * Metro resolves `castService.web.ts` (web) or `castService.native.ts`
 * (iOS/Android) over this file at runtime. This clean default exists so that:
 *  - TypeScript (`tsc --noEmit`) can resolve the import without platform-
 *    extension awareness.
 *  - Non-Metro tooling (test runners, SSR) gets a valid, side-effect-free module.
 *
 * It reports cast as unsupported and never produces a session or engine. Do NOT
 * import any platform-only SDK here (that is what the `.web` / `.native`
 * variants are for).
 */

import type { PlayerEngine } from '@/stores/playback/playerEngine';
import type { CastController, CastMediaMetadata, CastSessionState } from './types';

class NoopCastController implements CastController {
  isSupported(): boolean {
    return false;
  }

  getSessionState(): CastSessionState {
    return 'no_devices';
  }

  onSessionStateChange(_cb: (state: CastSessionState) => void): () => void {
    return () => {};
  }

  async requestSession(): Promise<void> {
    // No receiver to connect to off-device.
  }

  async endSession(): Promise<void> {
    // No session to end.
  }

  getDeviceName(): string | null {
    return null;
  }

  getEngine(): PlayerEngine | null {
    return null;
  }

  setMediaMetadata(_meta: CastMediaMetadata): void {
    // Nothing is loaded onto a receiver in the default build.
  }
}

export const castController: CastController = new NoopCastController();
