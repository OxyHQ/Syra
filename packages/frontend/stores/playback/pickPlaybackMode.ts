// ── Types ─────────────────────────────────────────────────────────────────────

export type PlaybackMode = 'native' | 'hlsjs' | 'progressive';

export interface PlaybackModeInput {
  isWeb: boolean;
  canPlayHlsNatively: boolean;
}

// ── Pure decision function ────────────────────────────────────────────────────

/**
 * Determine which playback engine to use for a resolved HLS stream.
 *
 * Every stream the resolver returns is HLS, so the only question is which
 * engine can play it:
 *  - native (iOS/Android)           → `'native'`  (AVPlayer/ExoPlayer, both play HLS+AES-128)
 *  - web + Safari                   → `'native'`  (Safari <audio> plays HLS natively)
 *  - web + Chrome/Firefox           → `'hlsjs'`   (hls.js required)
 *
 * `'progressive'` is not chosen here: it is the caller's fallback for tracks
 * with no stream resolution at all (uploaded audio served as a plain URL).
 *
 * This function is intentionally pure (no side-effects, no DOM access) so it
 * can be tested without a browser environment.
 */
export function pickPlaybackMode(input: PlaybackModeInput): PlaybackMode {
  const { isWeb, canPlayHlsNatively } = input;

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
