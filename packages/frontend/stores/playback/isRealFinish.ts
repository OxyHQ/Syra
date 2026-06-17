/**
 * Number of seconds before the end of a track within which a `didJustFinish`
 * event is considered a real (non-spurious) completion.
 *
 * Progressive and HLS streams can fire a false finish at the very start of
 * playback when duration metadata has not yet loaded (duration ≈ 0). This
 * guard rejects any finish where the current position is not close enough to
 * the known duration.
 */
export const FINISH_EPSILON_SEC = 1.5;
export const UNKNOWN_DURATION_MIN_POSITION_SEC = 3;

/**
 * Determine whether a `didJustFinish` playback event is a genuine track
 * completion rather than a spurious early-finish fired by the engine before
 * duration metadata has loaded.
 *
 * A finish is real when:
 *  - `durationSec` is known and positive (> 0), AND
 *  - `positionSec` is within `FINISH_EPSILON_SEC` of the end.
 *
 * A false finish at position ≈ 0 with unknown/zero duration evaluates to
 * `false`, protecting `handleTrackCompletion` from being called prematurely.
 *
 * @param durationSec - Known track duration in seconds (0 = unknown)
 * @param positionSec - Current playback position in seconds
 */
export function isRealFinish(durationSec: number, positionSec: number): boolean {
  if (durationSec > 0) {
    return positionSec >= durationSec - FINISH_EPSILON_SEC;
  }

  // Some streams, especially remote progressive/HLS sources, can emit a real
  // ended event while duration metadata is still unknown (0/Infinity). Keep the
  // original protection against startup false positives by requiring meaningful
  // playback progress before accepting an unknown-duration finish.
  return positionSec >= UNKNOWN_DURATION_MIN_POSITION_SEC;
}
