/**
 * useCast — reactive view of the Google Cast session for UI surfaces.
 *
 * Reads cast capability and session state straight from `castController` (the
 * platform-agnostic facade) and the casting flag / device name from the player
 * store, which already owns the local⇄cast output handoff. The UI talks to this
 * hook only — never to the cast SDK directly.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { castController } from '@/services/cast/castService';
import type { CastSessionState } from '@/services/cast/types';
import { usePlayerStore } from '@/stores/playerStore';

export interface UseCast {
  /** Whether this platform/build can cast at all (SDK present). */
  isSupported: boolean;
  /** Current cast session state. */
  state: CastSessionState;
  /** Whether playback is currently routed to a receiver. */
  isCasting: boolean;
  /** Friendly name of the connected receiver, or null. */
  deviceName: string | null;
  /** Open the cast picker / connect to a receiver. */
  requestSession: () => Promise<void>;
  /** End the active cast session. */
  endSession: () => Promise<void>;
}

function subscribe(onStoreChange: () => void): () => void {
  return castController.onSessionStateChange(onStoreChange);
}

export function useCast(): UseCast {
  // Re-renders whenever the session state changes (which also covers the web SDK
  // becoming ready, so `isSupported` re-evaluates as soon as it can cast).
  const state = useSyncExternalStore(subscribe, () => castController.getSessionState());
  const isCasting = usePlayerStore((s) => s.isCasting);
  const deviceName = usePlayerStore((s) => s.castDeviceName);

  const requestSession = useCallback(() => castController.requestSession(), []);
  const endSession = useCallback(() => castController.endSession(), []);

  return {
    isSupported: castController.isSupported(),
    state,
    isCasting,
    deviceName,
    requestSession,
    endSession,
  };
}
