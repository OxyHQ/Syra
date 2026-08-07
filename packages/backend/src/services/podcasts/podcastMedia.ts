/**
 * Podcast cover-art re-hosting — thin wrapper over the SHARED catalog image
 * pipeline (`mirrorCatalogImage`) that albums/artists/tracks use. It downloads
 * the external artwork (SSRF-guarded inside the pipeline via `validateUrlSecurity`),
 * produces the multi-resolution `imageSizes` variants in Syra S3, and extracts
 * `primaryColor`/`secondaryColor` — exactly like Artist/Album. No parallel
 * uploader: this only adapts the call for podcast/episode entities.
 *
 * Colors follow the catalog convention: a fresh mirror returns colors, but the
 * idempotent "unchanged image" path returns none, so callers must apply colors
 * with `replaceColors` (image changed) / `assignMissingColors` (unchanged) —
 * never blindly overwrite. `imageId !== previousImageId` signals a change.
 */

import { isLiveEntityId } from '@oxyhq/db';
import type { CatalogImageSizes, PodcastSource } from '@syra/shared-types';
import { mirrorCatalogImage } from '../catalog/catalogImageAssets';

export interface RehostedImage {
  /** Syra image id (resolved via /api/images/:id). */
  image: string;
  imageSizes: CatalogImageSizes;
  /** Present only when the image was freshly mirrored (see module note). */
  primaryColor?: string;
  secondaryColor?: string;
}

/**
 * Re-host a podcast/episode cover from its external URL into Syra S3. Idempotent
 * when `existingImageId`/`existingImageSizes` are passed and the source bytes are
 * unchanged. Returns undefined when the artwork can't be fetched/processed.
 */
export async function rehostPodcastImage(
  externalUrl: string,
  opts: {
    source: PodcastSource;
    entityType: 'podcast' | 'episode';
    externalId: string;
    existingImageId?: string;
    existingImageSizes?: CatalogImageSizes;
  },
): Promise<RehostedImage | undefined> {
  /**
   * `isLiveEntityId`, not `ObjectId.isValid`.
   *
   * This schema stores ids in TWO shapes — a 24-char ObjectId hex for every row
   * that predates the cutover, and a uuid v7 for every row created since. The
   * ObjectId-only test therefore returned `undefined` for every image minted
   * after the cutover, which silently disabled the idempotent "unchanged image"
   * path: `mirrorCatalogImage` re-downloads, re-processes and re-uploads the
   * artwork on EVERY crawl of every feed, and the caller sees `image !==
   * previousImageId` and replaces the extracted colors each time. Same defect,
   * and the same fix, as `db/catalog/serialize.ts`'s `normalizeImageRef`.
   */
  const existingImageId = isLiveEntityId(opts.existingImageId) ? opts.existingImageId : undefined;

  const asset = await mirrorCatalogImage([{ url: externalUrl }], {
    provider: opts.source,
    entityType: opts.entityType,
    externalId: opts.externalId,
    existingImageId,
    existingImageSizes: existingImageId ? opts.existingImageSizes : undefined,
  });
  if (!asset) return undefined;

  return {
    image: asset.imageId,
    imageSizes: asset.imageSizes,
    primaryColor: asset.primaryColor,
    secondaryColor: asset.secondaryColor,
  };
}
