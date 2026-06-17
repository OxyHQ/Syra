import type { ListeningSource } from '../../models/ListeningEvent';

/**
 * A play is counted as a "real" play (incrementing global play counts) only once
 * the listener has heard a meaningful portion. This is the industry-standard
 * guard against skip-spam inflating popularity (cf. the ~30s rule).
 */
export const PLAY_COMPLETION_THRESHOLD = 0.3;

/** Below this completion ratio a play is treated as a skip. */
export const SKIP_COMPLETION_THRESHOLD = 0.15;

/**
 * Per-source trust multiplier for taste signals. A play the user actively
 * sought out (searched, opened an artist/album) reflects taste more strongly
 * than something an algorithm queued (radio/recommendation), so the latter is
 * discounted to avoid recommendation feedback loops reinforcing themselves.
 */
const SOURCE_WEIGHT: Record<ListeningSource, number> = {
  search: 1.1,
  library: 1.2,
  playlist: 1.0,
  album: 1.0,
  artist: 1.0,
  charts: 0.9,
  queue: 0.9,
  radio: 0.6,
  recommendation: 0.6,
  unknown: 0.8,
};

export interface PlaySignal {
  completion: number;
  skipped: boolean;
  source: ListeningSource;
}

/**
 * Compute the taste weight contributed by a single play. A fully-listened track
 * from a high-trust source contributes ~1.0; a skip contributes a small
 * negative-leaning value so churning past a track gently cools its affinity
 * rather than warming it.
 *
 * Returned weight is clamped to [-0.3, 1.4].
 */
export function playTasteWeight(signal: PlaySignal): number {
  const sourceWeight = SOURCE_WEIGHT[signal.source] ?? SOURCE_WEIGHT.unknown;
  if (signal.skipped || signal.completion < SKIP_COMPLETION_THRESHOLD) {
    // A skip is a weak negative taste signal, dampened by source trust.
    return Math.max(-0.3, -0.15 * sourceWeight);
  }
  // Completion in [SKIP, 1] maps to engagement in (0, 1].
  const engagement = Math.min(1, Math.max(0, signal.completion));
  return Math.min(1.4, engagement * sourceWeight);
}

/**
 * Whether this play should increment the GLOBAL play count / popularity. Skips
 * and very short listens never inflate global popularity, regardless of source.
 */
export function countsAsGlobalPlay(signal: { completion: number; skipped: boolean }): boolean {
  return !signal.skipped && signal.completion >= PLAY_COMPLETION_THRESHOLD;
}

/**
 * Derive `completion` and `skipped` from raw position data so callers (and the
 * client) can send either a completion ratio directly or raw seconds.
 */
export function deriveCompletion(params: {
  listenedSec: number;
  durationSec?: number;
  explicitCompletion?: number;
}): { listenedSec: number; completion: number; skipped: boolean } {
  const listenedSec = Math.max(0, params.listenedSec);
  let completion: number;
  if (typeof params.explicitCompletion === 'number' && Number.isFinite(params.explicitCompletion)) {
    completion = Math.min(1, Math.max(0, params.explicitCompletion));
  } else if (params.durationSec && params.durationSec > 0) {
    completion = Math.min(1, listenedSec / params.durationSec);
  } else {
    // Unknown duration: treat any non-trivial listen as a moderate completion so
    // it still registers as a real play, but never a skip.
    completion = listenedSec >= 30 ? 0.5 : 0;
  }
  const skipped = completion < SKIP_COMPLETION_THRESHOLD;
  return { listenedSec, completion, skipped };
}
