/**
 * Map a raw lifetime play count onto Syra's normalised 0–100 popularity scale.
 *
 * Play counts span many orders of magnitude (a handful of plays to tens of
 * millions), so a linear mapping would crush almost everything to 0. We use a
 * log10 curve calibrated so that:
 *   - 0 plays            → 0
 *   - ~10 plays          → ~14
 *   - ~10k plays         → ~57
 *   - >= 10M plays       → 100 (clamped)
 *
 * The result is rounded to an integer in [0, 100].
 */
const POPULARITY_SATURATION_PLAYS = 10_000_000;

export function playCountToPopularity(playCount: number | undefined): number {
  if (typeof playCount !== 'number' || !Number.isFinite(playCount) || playCount <= 0) {
    return 0;
  }
  const capped = Math.min(playCount, POPULARITY_SATURATION_PLAYS);
  const score = (Math.log10(capped + 1) / Math.log10(POPULARITY_SATURATION_PLAYS + 1)) * 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}
