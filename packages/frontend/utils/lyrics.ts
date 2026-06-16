import type { LyricsLine } from '@syra/shared-types';

/**
 * Returns the index of the active synced lyric line for the given playback
 * position in milliseconds.
 *
 * The active line is the LAST line whose `timeMs <= positionMs`. Returns `-1`
 * when `positionMs` is before the first line or when `lines` is empty.
 *
 * Assumes `lines` is sorted by `timeMs` ascending (as guaranteed by the server).
 */
export function activeLyricLineIndex(lines: LyricsLine[], positionMs: number): number {
  if (lines.length === 0) return -1;

  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.timeMs <= positionMs) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}
