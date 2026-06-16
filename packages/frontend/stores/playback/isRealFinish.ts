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
  return durationSec > 0 && positionSec >= durationSec - FINISH_EPSILON_SEC;
}
