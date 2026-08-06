/**
 * The `image_assets` store — every rendered image byte Syra serves is an S3
 * object plus one row here, and this module owns both halves of that pair.
 *
 * ## The id is minted before the upload, and that ordering is load-bearing
 *
 * The S3 key embeds the asset id (`getS3ImageKey`), so the id has to exist
 * before the object does. `uuidv7()` mints it locally, exactly as
 * `new mongoose.Types.ObjectId()` did — the column keeps `generatedId()`'s
 * default for rows written without one, and an explicit value simply wins.
 *
 * The consequence is unchanged from the Mongo version and worth stating: an
 * upload that succeeds and an insert that then fails leaves an orphaned S3
 * object with no row. That is the safe direction — a row pointing at a missing
 * object would 404 on read — and the reverse ordering cannot be built, because
 * the key is not known until the id is.
 */

import { Readable } from 'stream';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { getS3ImageKey } from '../config/s3.config';
import { getDb } from '../db/postgres';
import {
  imageAssets,
  type CatalogImageEntityType,
  type CatalogImageProvider,
  type ImageAssetOwnerType,
} from '../db/schema/catalog';
import { uploadToS3, streamFromS3 } from './s3Service';

/**
 * The provenance of a mirrored catalog image.
 *
 * Stored as six flat columns (`schema/catalog.ts`) because it is queried by its
 * own fields, but it stays ONE nested object on this input: every caller builds
 * it as a unit or omits it entirely, and splitting it across six optional
 * parameters would let a caller supply a provider with no external id.
 */
export interface ImageAssetCatalogMetadata {
  provider?: CatalogImageProvider;
  entityType?: CatalogImageEntityType;
  externalId?: string;
  size?: string;
  sourceUrlHash?: string;
  sourceContentHash?: string;
}

export interface StoreImageAssetInput {
  buffer: Buffer;
  filename: string;
  contentType: string;
  ownerType: ImageAssetOwnerType;
  uploadedBy?: string;
  width?: number;
  height?: number;
  primaryColor?: string;
  secondaryColor?: string;
  catalog?: ImageAssetCatalogMetadata;
}

export interface StoredImageAssetColors {
  primaryColor?: string;
  secondaryColor?: string;
}

export async function storeImageAsset(input: StoreImageAssetInput): Promise<{
  id: string;
  s3Key: string;
}> {
  const imageId = uuidv7();
  const s3Key = getS3ImageKey(imageId, input.filename);

  await uploadToS3(s3Key, input.buffer, {
    contentType: input.contentType,
    metadata: {
      imageId,
      ownerType: input.ownerType,
      ...(input.uploadedBy ? { uploadedBy: input.uploadedBy } : {}),
      ...(input.catalog?.provider ? { provider: input.catalog.provider } : {}),
      ...(input.catalog?.entityType ? { entityType: input.catalog.entityType } : {}),
      ...(input.catalog?.externalId ? { externalId: input.catalog.externalId } : {}),
      ...(input.catalog?.size ? { size: input.catalog.size } : {}),
      ...(input.catalog?.sourceUrlHash ? { sourceUrlHash: input.catalog.sourceUrlHash } : {}),
      ...(input.catalog?.sourceContentHash
        ? { sourceContentHash: input.catalog.sourceContentHash }
        : {}),
    },
  });

  await getDb()
    .insert(imageAssets)
    .values({
      id: imageId,
      s3Key,
      filename: input.filename,
      contentType: input.contentType,
      byteSize: input.buffer.length,
      width: input.width,
      height: input.height,
      ownerType: input.ownerType,
      uploadedBy: input.uploadedBy,
      primaryColor: input.primaryColor,
      secondaryColor: input.secondaryColor,
      catalogProvider: input.catalog?.provider,
      catalogEntityType: input.catalog?.entityType,
      catalogExternalId: input.catalog?.externalId,
      catalogSize: input.catalog?.size,
      catalogSourceUrlHash: input.catalog?.sourceUrlHash,
      catalogSourceContentHash: input.catalog?.sourceContentHash,
    });

  return { id: imageId, s3Key };
}

export async function getImageAssetStream(imageId: string): Promise<{
  stream: Readable;
  contentLength: number;
  contentType?: string;
} | null> {
  // No id-shape pre-check: `image_assets.id` is `text`, so a malformed id
  // simply matches no row and the query answers the question a guard used to.
  const [asset] = await getDb()
    .select({ s3Key: imageAssets.s3Key, contentType: imageAssets.contentType })
    .from(imageAssets)
    .where(eq(imageAssets.id, imageId))
    .limit(1);

  if (!asset) return null;

  const result = await streamFromS3(asset.s3Key);
  return {
    stream: result.stream,
    contentLength: result.contentLength,
    contentType: result.contentType ?? asset.contentType,
  };
}

export async function getImageAssetColors(
  imageId: string
): Promise<StoredImageAssetColors | undefined> {
  const [asset] = await getDb()
    .select({
      primaryColor: imageAssets.primaryColor,
      secondaryColor: imageAssets.secondaryColor,
    })
    .from(imageAssets)
    .where(eq(imageAssets.id, imageId))
    .limit(1);

  // `secondaryColor` alone is not a palette — the Mongo version keyed the whole
  // result on `primaryColor` being present, and that is preserved.
  if (!asset?.primaryColor) return undefined;

  return {
    primaryColor: asset.primaryColor,
    secondaryColor: asset.secondaryColor ?? undefined,
  };
}

export async function getImageAssetSourceContentHash(
  imageId: string | undefined
): Promise<string | undefined> {
  if (!imageId) return undefined;

  const [asset] = await getDb()
    .select({ sourceContentHash: imageAssets.catalogSourceContentHash })
    .from(imageAssets)
    .where(eq(imageAssets.id, imageId))
    .limit(1);

  return asset?.sourceContentHash ?? undefined;
}
