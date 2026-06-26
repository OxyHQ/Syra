import type { CatalogImageSizes } from '@syra/shared-types';
import { pickCatalogImageUrl, type CatalogImageTarget } from '@/utils/pickImage';

/**
 * Podcast / episode artwork resolution.
 *
 * Cover art is now re-hosted on Syra (mirrors Artist/Album): `image` is the Syra
 * image id and `imageSizes` is the multi-resolution variant set, both resolved
 * through the shared catalog image picker (`/api/images/:id`). `imageSourceUrl`
 * keeps the original external artwork URL and is used ONLY as a fallback for
 * rows that have not been backfilled to Syra-hosted media yet.
 */
const ABSOLUTE_URL_RE = /^(https?:)?\/\//i;

/** The subset of a podcast/episode needed to resolve its artwork. */
export interface PodcastArtworkSource {
  image?: string;
  imageSizes?: CatalogImageSizes;
  imageSourceUrl?: string;
}

/**
 * Resolve podcast/episode artwork at a catalog target size — Syra-hosted media
 * first (exactly like Artist/Album), falling back to the original external URL
 * only when no Syra image exists yet.
 */
export function resolvePodcastImageUri(
  source: PodcastArtworkSource | undefined,
  target: CatalogImageTarget,
): string | undefined {
  if (!source) {
    return undefined;
  }
  const syraImage = pickCatalogImageUrl(undefined, source.image, target, source.imageSizes);
  if (syraImage) {
    return syraImage;
  }
  return resolveExternalImageUri(source.imageSourceUrl);
}

/**
 * Resolve a plain external image URL (directory-discovery candidates and
 * Podcasting 2.0 host/guest avatars, which are never re-hosted). Returns the
 * value only when it looks like an absolute URL.
 */
export function resolveExternalImageUri(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && ABSOLUTE_URL_RE.test(trimmed) ? trimmed : undefined;
}
