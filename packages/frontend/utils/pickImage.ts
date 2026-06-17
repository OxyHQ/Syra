import type { CatalogImageSizes, CatalogImageVariant, TrackImage } from '@syra/shared-types';
import { resolveCatalogImageUrl } from './catalogImages';

type ImageCandidate = {
  url: string;
  width: number;
};

function normalizeCandidate(urlValue: string | undefined, widthValue: number | undefined): ImageCandidate | null {
  if (!urlValue) return null;
  const url = resolveCatalogImageUrl(urlValue);
  if (!url) return null;

  return {
    url,
    width: typeof widthValue === 'number' && widthValue > 0 ? widthValue : 0,
  };
}

function candidateFromVariant(variant: CatalogImageVariant | undefined): ImageCandidate | null {
  if (!variant) return null;
  return normalizeCandidate(variant.url, variant.width) ?? normalizeCandidate(variant.id, variant.width);
}

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
  sizes?: CatalogImageSizes,
): string | undefined {
  const normalizedFallback = resolveCatalogImageUrl(fallback);

  const normalised = [
    ...Object.values(sizes ?? {})
      .map(candidateFromVariant)
      .filter((img): img is ImageCandidate => img !== null),
    ...(images ?? [])
      .map((img) => normalizeCandidate(img.url, img.width))
      .filter((img): img is ImageCandidate => img !== null),
  ];

  if (normalised.length === 0) return normalizedFallback;

  // Find the smallest image that is still at least as wide as the target.
  let best: ImageCandidate | undefined;
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
