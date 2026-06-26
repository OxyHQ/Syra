/**
 * Minimal shared interface satisfied by both expo-audio's AudioPlayer and the
 * web-only WebHlsPlayer. Only the members that playerStore.ts actually accesses
 * are declared — nothing more.
 *
 * AudioPlayer surface audit (from playerStore.ts):
 *   Properties (read):
 *     isLoaded: boolean
 *     currentTime: number
 *     duration: number
 *     playing: boolean
 *   Properties (write):
 *     volume: number
 *   Methods:
 *     play(): void
 *     pause(): void
 *     seekTo(seconds: number): Promise<void>
 *     replace(source: { uri?: string }): void
 *     remove(): void
 *     addListener('playbackStatusUpdate', callback): void
 *   Listener status object:
 *     { isLoaded, didJustFinish, playing, currentTime, duration }
 */

// ── Status shape emitted by 'playbackStatusUpdate' ────────────────────────────

export interface PlaybackStatusUpdate {
  isLoaded: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  didJustFinish: boolean;
}

// ── Minimal source type for replace() ─────────────────────────────────────────

export interface AudioSourceInput {
  uri?: string;
}

// ── Shared engine interface ───────────────────────────────────────────────────

/**
 * Minimal player interface satisfied by both expo-audio's `AudioPlayer` and
 * `WebHlsPlayer`. The store types its `player` field as `PlayerEngine | null`
 * so that engine switching stays fully typed.
 */
export interface PlayerEngine {
  /** Whether playback is currently active (not paused). */
  readonly playing: boolean;
  /** Whether enough data has been loaded to begin playback. */
  readonly isLoaded: boolean;
  /** Current playback position in seconds. */
  readonly currentTime: number;
  /** Total duration in seconds (0 when unknown). */
  readonly duration: number;
  /** Playback volume in the range [0, 1]. */
  volume: number;

  /** Start or resume playback. */
  play(): void;
  /** Pause playback. */
  pause(): void;
  /**
   * Set the playback rate (1 = normal). Used for podcast speed control.
   * Optional because only some engines expose it; callers guard with `?.`.
   * expo-audio's `AudioPlayer.setPlaybackRate` satisfies this directly.
   */
  setPlaybackRate?(rate: number): void;
  /** Seek to an absolute position in seconds. */
  seekTo(seconds: number): Promise<void>;
  /** Replace the current source. Playback state is preserved where possible. */
  replace(source: AudioSourceInput): void;
  /** Subscribe to playback status updates. */
  addListener(event: 'playbackStatusUpdate', callback: (status: PlaybackStatusUpdate) => void): void;
  /** Destroy the player and release all resources. */
  remove(): void;
}
