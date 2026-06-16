/**
 * Audio quality → HLS bitrate mapping and entitlement-based gating.
 *
 * The server enforces bitrate caps — the client preference is a hint, but the
 * actual rendition served is bounded by the user's subscription tier and the
 * data-saver setting.
 */

import type { AudioQuality } from '@syra/shared-types';
import type { Entitlement } from '../premium/entitlement';

/** HLS bitrate (kbps) for each audio quality tier. */
export const BITRATE_BY_QUALITY: Record<AudioQuality, number> = {
  low: 96,
  normal: 160,
  high: 320,
  very_high: 320,
};

/** Maximum bitrate (kbps) for free-tier users. */
export const FREE_MAX_KBPS = 160;

/** Maximum bitrate (kbps) when data-saver mode is enabled. */
export const DATASAVER_MAX_KBPS = 96;

/** Look up the target bitrate for a quality tier. */
export function bitrateForQuality(q: AudioQuality): number {
  return BITRATE_BY_QUALITY[q];
}

/**
 * Compute the effective maximum HLS bitrate for a user given their preferences
 * and subscription entitlement.
 *
 * Caps applied in order:
 *  1. Base bitrate from audioQuality preference (defaults to 'normal').
 *  2. Free-tier cap (FREE_MAX_KBPS) if user is not premium.
 *  3. Data-saver cap (DATASAVER_MAX_KBPS) if dataSaver is enabled.
 *     (Data-saver always wins — even premium users are capped when it is on.)
 */
export function computeMaxBitrateKbps(
  prefs: { audioQuality?: AudioQuality; dataSaver?: boolean },
  entitlement: Entitlement,
): number {
  let base = bitrateForQuality(prefs.audioQuality ?? 'normal');

  if (!entitlement.isPremium) {
    base = Math.min(base, FREE_MAX_KBPS);
  }

  if (prefs.dataSaver) {
    base = Math.min(base, DATASAVER_MAX_KBPS);
  }

  return base;
}
