import type { AudioPlayer } from 'expo-audio';
import type { StreamResolution } from '@/services/streamService';
import type { AttachResult } from './attachSource.types';
import { pickPlaybackMode, canPlayHlsNatively } from './pickPlaybackMode';

/**
 * Web implementation.
 *
 * Uses `pickPlaybackMode` to select the correct strategy:
 *
 * - `'progressive'` (audius) — `player.replace()` with the direct URL.
 * - `'native'` (HLS on Safari) — `player.replace()` with the HLS master URL;
 *   Safari's native <audio> handles HLS+AES-128.
 * - `'hlsjs'` (HLS on Chrome/Firefox) — **NOT YET IMPLEMENTED**.
 *   expo-audio's web player stores the HTMLAudioElement in a TypeScript-`private`
 *   field (`AudioPlayerWeb.media`) with no public accessor. Accessing it would
 *   require `as any` which is banned. The clean implementation requires a
 *   web-only raw `HTMLAudioElement` + hls.js path that bypasses expo-audio's
 *   `createAudioPlayer` for this mode.
 *   See: `AudioPlayerWeb.media` in `expo-audio/src/AudioPlayer.web.ts`.
 *
 * Until the raw-element fork is approved and built, `hlsjs` mode throws so
 * callers can fall back gracefully instead of silently serving a broken stream.
 */
export function attachSource(player: AudioPlayer, resolution: StreamResolution): AttachResult {
  const mode = pickPlaybackMode({
    type: resolution.type,
    isWeb: true,
    canPlayHlsNatively: canPlayHlsNatively(),
  });

  switch (mode) {
    case 'progressive':
    case 'native':
      // Safari native HLS and all progressive streams use player.replace()
      player.replace({ uri: resolution.url });
      return { detach: () => {} };

    case 'hlsjs':
      // hls.js integration requires access to the underlying HTMLAudioElement.
      // expo-audio's web player does not expose it publicly (private field).
      // The clean fix is a web-only raw-HTMLAudioElement + hls.js path that
      // the store uses in place of expo-audio for hlsjs mode.
      // Raise to team-lead before implementing the raw-element fork.
      throw new Error(
        'HLS playback on this browser requires hls.js integration with a raw ' +
        'HTMLAudioElement. expo-audio web does not expose the underlying media element. ' +
        'This mode requires the raw-element fork — pending team-lead approval.',
      );
  }
}
