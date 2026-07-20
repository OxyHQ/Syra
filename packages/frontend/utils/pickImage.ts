import type { CatalogImageSizes, CatalogImageVariant, TrackImage } from '@syra/shared-types';
import { resolveCatalogImageUrl } from './catalogImages';

type ImageCandidate = {
  url: string;
  width: number;
};

const ABSOLUTE_URL_RE = /^(https?:)?\/\//i;

/**
 * Resolve a plain external image URL — used for artwork that is never re-hosted
 * on Syra (podcast/episode covers not yet backfilled, and Podcasting 2.0
 * host/guest avatars). Returns the value only when it looks like an absolute URL.
 */
export function resolveExternalImageUri(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed && ABSOLUTE_URL_RE.test(trimmed) ? trimmed : undefined;
}

export const CATALOG_IMAGE_TARGET_WIDTH = {
  icon: 64,
  thumbnail: 80,
  smallArtwork: 180,
  card: 300,
  detailArtwork: 520,
  hero: 1000,
} as const;

export type CatalogImageTarget = keyof typeof CATALOG_IMAGE_TARGET_WIDTH;

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
 * single-URL coverArt / image field) when `images` is empty or undefined, and
 * finally to `externalFallback` (a raw, never-re-hosted external URL such as an
 * un-backfilled podcast cover) when no Syra-hosted image resolves.
 *
 * Entries with a missing or zero width are treated as the least-preferred
 * option (width = 0) and never crash the function.
 */
export function pickImageUrl(
  images: TrackImage[] | undefined,
  fallback: string | undefined,
  preferredWidth: number,
  sizes?: CatalogImageSizes,
  externalFallback?: string,
): string | undefined {
  const normalizedFallback = resolveCatalogImageUrl(fallback);
  const external = () => resolveExternalImageUri(externalFallback);

  const normalised = [
    ...Object.values(sizes ?? {})
      .map(candidateFromVariant)
      .filter((img): img is ImageCandidate => img !== null),
    ...(images ?? [])
      .map((img) => normalizeCandidate(img.url, img.width))
      .filter((img): img is ImageCandidate => img !== null),
  ];

  if (normalised.length === 0) return normalizedFallback ?? external();

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

  return best?.url ?? normalizedFallback ?? external();
}

/**
 * Resolve a catalog image at a named target size — Syra-hosted media first
 * (id/size variants via `/api/images/:id`), then the single-URL `fallback`, then
 * an optional raw `externalFallback` (a never-re-hosted external URL, e.g. an
 * un-backfilled podcast/episode cover). This is the ONE catalog image resolver;
 * there is no separate podcast resolver.
 */
export function pickCatalogImageUrl(
  images: TrackImage[] | undefined,
  fallback: string | undefined,
  target: CatalogImageTarget,
  sizes?: CatalogImageSizes,
  externalFallback?: string,
): string | undefined {
  return pickImageUrl(images, fallback, CATALOG_IMAGE_TARGET_WIDTH[target], sizes, externalFallback);
}
