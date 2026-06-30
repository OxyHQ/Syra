/**
 * Manual jest mock for the cast service.
 *
 * Activated with `jest.mock('@/services/cast/castService')`. Exposes the same
 * `castController` the store imports, plus typed test helpers so specs can drive
 * the session state and inspect the cast engine without `as any` casts.
 */
import type { PlayerEngine } from '@/stores/playback/playerEngine';
import { CAST_HLS_CONTENT_TYPE } from '../types';
import type { CastController, CastSessionState } from '../types';

/** A {@link PlayerEngine} whose methods are jest spies for assertions. */
export type MockCastEngine = {
  playing: boolean;
  isLoaded: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  play: jest.Mock;
  pause: jest.Mock;
  setPlaybackRate: jest.Mock;
  seekTo: jest.Mock;
  replace: jest.Mock;
  addListener: jest.Mock;
  remove: jest.Mock;
};

export const castTestEngine: MockCastEngine = {
  playing: false,
  isLoaded: true,
  currentTime: 0,
  duration: 0,
  volume: 1,
  play: jest.fn(),
  pause: jest.fn(),
  setPlaybackRate: jest.fn(),
  seekTo: jest.fn(async () => {}),
  replace: jest.fn(),
  addListener: jest.fn(),
  remove: jest.fn(),
};

let sessionState: CastSessionState = 'available';
// The content type most recently applied to a cast load, mirroring how the real
// controllers hold it and pass it to the engine on replace().
let contentType: string = CAST_HLS_CONTENT_TYPE;
// The store registers its handler once at creation; kept across resets so specs
// can fire session transitions exactly like the real controller would.
let registered: ((state: CastSessionState) => void) | null = null;

export const castController: CastController = {
  isSupported: jest.fn(() => true),
  getSessionState: jest.fn(() => sessionState),
  onSessionStateChange: jest.fn((cb: (state: CastSessionState) => void) => {
    registered = cb;
    return () => {
      registered = null;
    };
  }),
  requestSession: jest.fn(async () => {}),
  endSession: jest.fn(async () => {}),
  getDeviceName: jest.fn(() => (sessionState === 'connected' ? 'Living Room TV' : null)),
  getEngine: jest.fn((): PlayerEngine | null => (sessionState === 'connected' ? castTestEngine : null)),
  setMediaMetadata: jest.fn(),
  setContentType: jest.fn((nextContentType: string) => {
    contentType = nextContentType;
  }),
};

/** The content type most recently applied to a cast load (set via setContentType). */
export function getCastContentType(): string {
  return contentType;
}

/** Set the reported session state without notifying subscribers. */
export function setCastSessionState(state: CastSessionState): void {
  sessionState = state;
}

/** Transition the session state AND notify the store's subscriber, as the SDK would. */
export function fireCastSessionState(state: CastSessionState): void {
  sessionState = state;
  registered?.(state);
}

/**
 * Reset the reported session state between specs. Spy call history is cleared by
 * the test's `jest.clearAllMocks()`; the store's subscription (`registered`) is a
 * plain closure variable and intentionally survives, mirroring the real, long-
 * lived controller.
 */
export function resetCastMock(): void {
  sessionState = 'available';
  contentType = CAST_HLS_CONTENT_TYPE;
}
