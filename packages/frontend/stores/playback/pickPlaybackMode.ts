// ── Types ─────────────────────────────────────────────────────────────────────

export type PlaybackMode = 'native' | 'hlsjs' | 'progressive';

export interface PlaybackModeInput {
  type: 'hls' | 'audius';
  isWeb: boolean;
  canPlayHlsNatively: boolean;
}

// ── Pure decision function ────────────────────────────────────────────────────

/**
 * Determine which playback strategy to use for a given stream resolution.
 *
 * Decision table:
 *  - `audius`                                → `'progressive'`  (direct URL, any platform)
 *  - `hls`  + native (iOS/Android)           → `'native'`       (AVPlayer/ExoPlayer, both play HLS+AES-128)
 *  - `hls`  + web + Safari                   → `'native'`       (Safari <audio> plays HLS natively)
 *  - `hls`  + web + Chrome/Firefox           → `'hlsjs'`        (hls.js required)
 *
 * This function is intentionally pure (no side-effects, no DOM access) so it
 * can be tested without a browser environment.
 */
export function pickPlaybackMode(input: PlaybackModeInput): PlaybackMode {
  const { type, isWeb, canPlayHlsNatively } = input;

  if (type === 'audius') {
    return 'progressive';
  }

  // type === 'hls'
  if (!isWeb) {
    // Native: AVPlayer (iOS) / ExoPlayer (Android) handle HLS+AES-128 natively
    return 'native';
  }

  // Web
  return canPlayHlsNatively ? 'native' : 'hlsjs';
}

// ── Browser helper (impure, DOM-dependent) ────────────────────────────────────

/**
 * Detect whether the current browser can play HLS natively.
 *
 * Safari on macOS/iOS supports HLS via `<audio canPlayType>`. Chrome and
 * Firefox do not; they require hls.js.
 *
 * Safe in SSR/native contexts: without a DOM it returns false.
 */
export function canPlayHlsNatively(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  const audio = document.createElement('audio');
  return audio.canPlayType('application/vnd.apple.mpegurl') !== '';
}
