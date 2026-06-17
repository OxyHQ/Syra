import type { TrackImage } from '@syra/shared-types';
import { resolveCatalogImageUrl } from './catalogImages';

/**
 * Pick the best image URL for a target render width.
 *
 * Strategy: choose the smallest image whose width >= preferredWidth (avoids
 * upscale-blur while not over-fetching); if none is large enough, return the
 * image with the largest available width. Falls back to `fallback` (the
 * single-URL coverArt / image field) when `images` is empty or undefined.
 *
 * Entries with a missing or zero width are treated as the least-preferred
 * option (width = 0) and never crash the function.
 */
export function pickImageUrl(
  images: TrackImage[] | undefined,
  fallback: string | undefined,
  preferredWidth: number,
): string | undefined {
  const normalizedFallback = resolveCatalogImageUrl(fallback) ?? fallback;
  if (!images || images.length === 0) return normalizedFallback;

  // Normalise: treat missing/non-positive width as 0 so comparisons are safe.
  const normalised = images
    .map((img) => {
      const url = resolveCatalogImageUrl(img.url) ?? img.url;
      return {
        url,
        width: typeof img.width === 'number' && img.width > 0 ? img.width : 0,
      };
    })
    .filter((img) => !/^https?:\/\//i.test(img.url) || img.url.includes('/api/images/'));

  // Find the smallest image that is still at least as wide as the target.
  let best: { url: string; width: number } | undefined;
  for (const img of normalised) {
    if (img.width >= preferredWidth) {
      if (best === undefined || img.width < best.width) {
        best = img;
      }
    }
  }

  // None were large enough — use the widest available instead.
  if (best === undefined) {
    for (const img of normalised) {
      if (best === undefined || img.width > best.width) {
        best = img;
      }
    }
  }

  return best?.url ?? normalizedFallback;
}
