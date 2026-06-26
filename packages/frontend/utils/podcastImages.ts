import { oxyServices } from '@/lib/oxyServices';

/**
 * Podcast / episode artwork resolution.
 *
 * Podcast and episode `image` values come from two very different origins:
 *   - **External (rss) shows/episodes** carry a PLAIN external URL (the
 *     publisher's CDN). These must be rendered directly — they are NOT Oxy
 *     file ids and must never go through `getFileDownloadUrl` / the catalog
 *     image resolver (which would discard them).
 *   - **Syra-hosted (`source: 'syra'`) media** stores an Oxy file id, which is
 *     resolved through `oxyServices.getFileDownloadUrl(id, variant)` like the
 *     rest of the Oxy media chokepoint.
 *
 * This helper detects which case applies from the string itself: anything that
 * looks like an absolute URL is used as-is; everything else is treated as an
 * Oxy file id.
 */
const ABSOLUTE_URL_RE = /^(https?:)?\/\//i;

export function resolvePodcastImageUri(
  image: string | undefined,
  variant?: 'thumb' | 'medium' | 'full',
): string | undefined {
  if (!image) {
    return undefined;
  }
  const trimmed = image.trim();
  if (!trimmed) {
    return undefined;
  }
  if (ABSOLUTE_URL_RE.test(trimmed)) {
    return trimmed;
  }
  return oxyServices.getFileDownloadUrl(trimmed, variant);
}
