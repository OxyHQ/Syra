import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import sharp from 'sharp';
import {
  catalogImageSizesSchema,
  type CatalogImageSizes,
  type CatalogImageVariant,
  type TrackImage,
} from '@syra/shared-types';
import { extractPredominantColorsFromBuffer } from '../colorExtractionService';
import { logger } from '../../utils/logger';
import { validateUrlSecurity } from '../../utils/urlSecurity';
import { getImageAssetSourceContentHash, storeImageAsset } from '../imageAssetService';
import type { CatalogImageProvider } from '../../models/ImageAsset';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'SyraCatalogImporter/1.0';

const IMAGE_SIZES = [
  ['small', 160],
  ['medium', 320],
  ['large', 640],
  ['xlarge', 960],
  ['xxlarge', 1280],
] as const;

export type CatalogImageEntityType = 'artist' | 'track' | 'album' | 'playlist' | 'podcast' | 'episode';

export interface CatalogImageContext {
  provider: CatalogImageProvider;
  entityType: CatalogImageEntityType;
  externalId: string;
  existingImageId?: string;
  existingImageSizes?: CatalogImageSizes;
  existingSourceContentHash?: string;
}

export interface CatalogImageAsset {
  imageId: string;
  imageSizes: CatalogImageSizes;
  primaryColor?: string;
  secondaryColor?: string;
  sourceUrlHash: string;
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

function normalizeSourceUrl(sourceUrl: string): string {
  return new URL(sourceUrl).toString();
}

function downloadImage(sourceUrl: string, redirectsRemaining = MAX_REDIRECTS): Promise<{ buffer: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const security = validateUrlSecurity(sourceUrl);
    if (!security.valid) {
      reject(new Error(security.error ?? 'Image URL failed security validation'));
      return;
    }

    const parsed = new URL(sourceUrl);
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        Accept: 'image/*',
        'User-Agent': USER_AGENT,
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const statusCode = res.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400) {
        res.resume();
        if (!res.headers.location) {
          reject(new Error(`Image redirect missing location (${statusCode})`));
          return;
        }
        if (redirectsRemaining <= 0) {
          reject(new Error('Too many image redirects'));
          return;
        }
        const redirectedUrl = new URL(res.headers.location, parsed).toString();
        downloadImage(redirectedUrl, redirectsRemaining - 1).then(resolve).catch(reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(new Error(`Image request failed with status ${statusCode}`));
        return;
      }

      const contentType = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!contentType.startsWith('image/')) {
        res.resume();
        reject(new Error('Image response is not an image'));
        return;
      }

      const contentLength = Number.parseInt(String(res.headers['content-length'] ?? '0'), 10);
      if (contentLength > MAX_IMAGE_BYTES) {
        res.resume();
        reject(new Error('Image is too large'));
        return;
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;
      res.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_IMAGE_BYTES) {
          res.destroy(new Error('Image is too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType }));
    });

    req.on('timeout', () => {
      req.destroy(new Error('Image request timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

async function writeCatalogImage(
  buffer: Buffer,
  contentType: string,
  size: string,
  dimensions: { width: number; height: number },
  context: CatalogImageContext,
  sourceUrlHash: string,
  sourceContentHash: string,
  colors: { primary?: string; secondary?: string },
): Promise<CatalogImageVariant> {
  const result = await storeImageAsset({
    buffer,
    filename: `${context.provider}-${context.entityType}-${context.externalId}-${size}`,
    contentType,
    ownerType: context.entityType,
    width: dimensions.width,
    height: dimensions.height,
    primaryColor: colors.primary,
    secondaryColor: colors.secondary,
    catalog: {
      provider: context.provider,
      entityType: context.entityType,
      externalId: context.externalId,
      size,
      sourceUrlHash,
      sourceContentHash,
    },
  });

  const id = result.id;
  return {
    id,
    url: `/api/images/${id}`,
    width: dimensions.width,
    height: dimensions.height,
  };
}

async function createImageSizes(
  sourceBuffer: Buffer,
  context: CatalogImageContext,
  sourceUrlHash: string,
  sourceContentHash: string,
  colors: { primary?: string; secondary?: string },
): Promise<CatalogImageSizes> {
  const metadata = await sharp(sourceBuffer).metadata();
  const originalWidth = metadata.width ?? 0;
  const originalHeight = metadata.height ?? 0;
  const sizes: CatalogImageSizes = {};

  for (const [name, width] of IMAGE_SIZES) {
    const transformed = await sharp(sourceBuffer)
      .resize({ width, height: width, fit: 'cover', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });

    sizes[name] = await writeCatalogImage(
      transformed.data,
      'image/webp',
      name,
      { width: transformed.info.width, height: transformed.info.height },
      context,
      sourceUrlHash,
      sourceContentHash,
      colors,
    );
  }

  sizes.original = await writeCatalogImage(
    sourceBuffer,
    metadata.format ? `image/${metadata.format}` : 'application/octet-stream',
    'original',
    { width: originalWidth, height: originalHeight },
    context,
    sourceUrlHash,
    sourceContentHash,
    colors,
  );

  return catalogImageSizesSchema.parse(sizes);
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
      const normalizedSourceUrl = normalizeSourceUrl(sourceUrl);
      const sourceUrlHash = hashValue(normalizedSourceUrl);
      const { buffer } = await downloadImage(normalizedSourceUrl);
      const sourceContentHash = hashValue(buffer);

      const existingSourceContentHash = context.existingSourceContentHash
        ?? await getImageAssetSourceContentHash(context.existingImageId);
      if (
        context.existingImageId &&
        context.existingImageSizes &&
        existingSourceContentHash === sourceContentHash
      ) {
        const existingSizes = catalogImageSizesSchema.parse(context.existingImageSizes);
        return {
          imageId: context.existingImageId,
          imageSizes: existingSizes,
          sourceUrlHash,
          sourceContentHash,
        };
      }

      const extractedColors = await extractPredominantColorsFromBuffer(buffer);
      const colors = {
        primary: extractedColors.primary,
        secondary: extractedColors.secondary,
      };
      const imageSizes = await createImageSizes(
        buffer,
        context,
        sourceUrlHash,
        sourceContentHash,
        colors,
      );
      const imageId = imageSizes.large?.id
        ?? imageSizes.xlarge?.id
        ?? imageSizes.medium?.id
        ?? imageSizes.original?.id;

      if (!imageId) {
        throw new Error('No image variants were created');
      }

      return {
        imageId,
        imageSizes,
        primaryColor: colors.primary,
        secondaryColor: colors.secondary,
        sourceUrlHash,
        sourceContentHash,
      };
    } catch (error) {
      logger.warn('[CatalogImageAssets] Failed to mirror catalog image candidate', {
        provider: context.provider,
        entityType: context.entityType,
        externalId: context.externalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.warn('[CatalogImageAssets] Failed to mirror catalog image', {
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
