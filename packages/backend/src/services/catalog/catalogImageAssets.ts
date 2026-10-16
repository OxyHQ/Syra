/**
 * Catalogue artwork: an external image (Cover Art Archive, Wikimedia Commons, a
 * podcast feed) becomes a Syra image, stored in Oxy Files as a file the SYRA
 * application owns (OxyHQ/oxy ADR 0041).
 *
 * ## Oxy fetches it, once
 *
 * `importAppFile` hands Oxy the URL. Oxy downloads it with its own SSRF-safe
 * fetcher (https only, public addresses only, bounded redirects, size and time),
 * stores it, and remembers the source: importing the same URL again answers the
 * file it already has without a request, and the same bytes from a different URL
 * are the same file. That is everything Syra used to do by hand — its own
 * downloader, the URL-hash and content-hash lookups before and after it, and the
 * script that merged the duplicates they still missed — and none of it is here
 * any more.
 *
 * ## One file, six rows
 *
 * The six sizes every DTO carries are six `image_assets` rows naming the one file
 * and an Oxy rendition each (`oxyFiles/images.ts`); Oxy renders them. A file that
 * already has its six rows reuses them, so many episodes sharing a season's
 * artwork share one set, as they did before — by file id now.
 *
 * ## Plain http
 *
 * Oxy imports https only, at every hop. An `http://` candidate is asked for over
 * https; a host that does not serve it fails that candidate, and the next one is
 * tried. Syra no longer downloads anything over plain http.
 */

import * as crypto from 'crypto';
import { URL } from 'url';
import type { CatalogImageSizes, TrackImage } from '@syra/shared-types';
import { eq } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { getDb } from '../../db/postgres';
import {
  imageAssets,
  type CatalogImageEntityType,
  type CatalogImageProvider,
} from '../../db/schema/catalog';
import { oxyFiles } from '../oxyFiles/client';
import {
  findOxyImageSet,
  insertOxyImageSet,
  measureOxyFile,
  type StoredOxyFile,
} from '../oxyFiles/images';

export interface CatalogImageContext {
  provider: CatalogImageProvider;
  entityType: CatalogImageEntityType;
  externalId: string;
  /**
   * The entity's current image, so an unchanged source keeps it rather than
   * switching to another set of the same file — and so a re-crawl asks the
   * source whether the image changed (`revalidate`).
   */
  existingImageId?: string;
  existingImageSizes?: CatalogImageSizes;
}

export interface CatalogImageAsset {
  imageId: string;
  imageSizes: CatalogImageSizes;
  primaryColor?: string;
  secondaryColor?: string;
  sourceUrlHash?: string;
  sourceContentHash: string;
}

function hashValue(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function usableImageUrls(images: TrackImage[] | undefined): string[] {
  if (!Array.isArray(images)) return [];
  const urls: string[] = [];
  for (const image of images) {
    if (typeof image?.url === 'string' && image.url.trim().length > 0) {
      urls.push(image.url.trim());
    }
  }
  return urls;
}

/** The URL Oxy is asked to import: normalized, and https. */
export function importableSourceUrl(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url.toString();
}

/** The Oxy file the entity's current image is stored as, if any. */
async function existingImageFileId(imageId: string | undefined): Promise<string | undefined> {
  if (!imageId) return undefined;
  const [row] = await getDb()
    .select({ oxyFileId: imageAssets.oxyFileId })
    .from(imageAssets)
    .where(eq(imageAssets.id, imageId))
    .limit(1);
  return row?.oxyFileId ?? undefined;
}

type MirrorCatalogImageImplementation = (
  images: TrackImage[] | undefined,
  context: CatalogImageContext,
) => Promise<CatalogImageAsset | undefined>;

async function mirrorCatalogImageInternal(
  images: TrackImage[] | undefined,
  context: CatalogImageContext,
): Promise<CatalogImageAsset | undefined> {
  const sourceUrls = usableImageUrls(images);
  if (sourceUrls.length === 0) return undefined;

  for (const sourceUrl of sourceUrls) {
    try {
      const importUrl = importableSourceUrl(sourceUrl);
      const sourceUrlHash = hashValue(importUrl);
      const imported = await oxyFiles().importAppFile(importUrl, {
        visibility: 'public',
        // A re-crawl of a known entity asks the source (ETag / Last-Modified)
        // whether the artwork changed; a first sight never needs to.
        ...(context.existingImageId ? { revalidate: true } : {}),
      });
      const file: StoredOxyFile = {
        id: imported.file.id,
        sha256: imported.file.sha256,
        size: imported.file.size,
        mime: imported.file.mime,
      };

      // Unchanged: the entity's own set, untouched (and no colors — the caller
      // keeps the ones it has).
      if (
        context.existingImageId &&
        context.existingImageSizes &&
        (await existingImageFileId(context.existingImageId)) === file.id
      ) {
        return {
          imageId: context.existingImageId,
          imageSizes: context.existingImageSizes,
          sourceUrlHash,
          sourceContentHash: file.sha256,
        };
      }

      const existing = await findOxyImageSet(file.id);
      if (existing) {
        return {
          imageId: existing.imageId,
          imageSizes: existing.imageSizes,
          primaryColor: existing.primaryColor,
          secondaryColor: existing.secondaryColor,
          sourceUrlHash,
          sourceContentHash: file.sha256,
        };
      }

      const pixels = await measureOxyFile(file.id);
      const set = await insertOxyImageSet({
        file,
        pixels,
        ownerType: context.entityType,
        filename: `${context.provider}-${context.entityType}-${context.externalId}`,
        catalog: {
          provider: context.provider,
          entityType: context.entityType,
          externalId: context.externalId,
          sourceUrlHash,
        },
      });
      return {
        imageId: set.imageId,
        imageSizes: set.imageSizes,
        primaryColor: set.primaryColor,
        secondaryColor: set.secondaryColor,
        sourceUrlHash,
        sourceContentHash: file.sha256,
      };
    } catch (error) {
      logger.warn('[CatalogImageAssets] Failed to import catalog image candidate', {
        provider: context.provider,
        entityType: context.entityType,
        externalId: context.externalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.warn('[CatalogImageAssets] Failed to import catalog image', {
    provider: context.provider,
    entityType: context.entityType,
    externalId: context.externalId,
    candidates: sourceUrls.length,
  });
  return undefined;
}

let mirrorCatalogImageImplementation: MirrorCatalogImageImplementation = mirrorCatalogImageInternal;

export function setCatalogImageMirrorImplementationForTests(
  implementation?: MirrorCatalogImageImplementation,
): void {
  mirrorCatalogImageImplementation = implementation ?? mirrorCatalogImageInternal;
}

export async function mirrorCatalogImage(
  images: TrackImage[] | undefined,
  context: CatalogImageContext,
): Promise<CatalogImageAsset | undefined> {
  return mirrorCatalogImageImplementation(images, context);
}
