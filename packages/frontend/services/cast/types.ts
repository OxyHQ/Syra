/**
 * Shared Google Cast types.
 *
 * These are platform-agnostic and imported by the clean default, the web, and
 * the native cast service variants. The key contract is that a connected cast
 * session exposes a {@link PlayerEngine} (the SAME interface the local audio
 * engines satisfy), so the player store can later swap its `player` field to a
 * cast engine without scattering `if (casting)` branches.
 */

import type { PlayerEngine } from '@/stores/playback/playerEngine';

// ── Session state ─────────────────────────────────────────────────────────────

/**
 * Normalized cast session state, decoupled from the platform SDK enums.
 *
 *  - `no_devices`  — no cast receivers are discoverable.
 *  - `available`   — receivers exist but no session is established.
 *  - `connecting`  — a session is being established.
 *  - `connected`   — a session is established and media can be controlled.
 */
export type CastSessionState = 'no_devices' | 'available' | 'connecting' | 'connected';

// ── Media metadata ────────────────────────────────────────────────────────────

/** Metadata shown on the cast receiver / remote-control surfaces. */
export interface CastMediaMetadata {
  title?: string;
  subtitle?: string;
  artworkUrl?: string;
}

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * Platform-agnostic facade over the Google Cast SDK.
 *
 * One instance is exported per platform (`castController`); the player store and
 * UI talk to this interface only — never to `cast.framework` /
 * `react-native-google-cast` directly.
 */
export interface CastController {
  /** Whether this platform/build can cast at all (SDK present). */
  isSupported(): boolean;
  /** The current session state. */
  getSessionState(): CastSessionState;
  /** Subscribe to session-state changes. Returns an unsubscribe function. */
  onSessionStateChange(cb: (state: CastSessionState) => void): () => void;
  /** Open the cast picker / connect to a receiver. */
  requestSession(): Promise<void>;
  /** End the active cast session. */
  endSession(): Promise<void>;
  /** Friendly name of the connected receiver, or null when no session is connected. */
  getDeviceName(): string | null;
  /**
   * A live {@link PlayerEngine} bound to the active cast session, or null when not
   * connected. A fresh engine is produced after a previous one is `remove()`d so
   * the player store can tear an engine down between tracks and reload via the
   * next engine — `remove()` never ends the underlying session.
   */
  getEngine(): PlayerEngine | null;
  /** Set metadata applied to the next media loaded onto the receiver. */
  setMediaMetadata(meta: CastMediaMetadata): void;
}

// ── Shared constants ──────────────────────────────────────────────────────────

/** MIME type used when loading Syra HLS master playlists onto a receiver. */
export const CAST_HLS_CONTENT_TYPE = 'application/x-mpegURL';
