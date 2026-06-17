import mongoose from 'mongoose';
import { Readable } from 'stream';
import { getS3ImageKey } from '../config/s3.config';
import { ImageAssetModel, ImageAssetOwnerType, ImageAssetCatalogMetadata } from '../models/ImageAsset';
import { uploadToS3, streamFromS3 } from './s3Service';

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
  const imageId = new mongoose.Types.ObjectId();
  const s3Key = getS3ImageKey(imageId.toString(), input.filename);

  await uploadToS3(s3Key, input.buffer, {
    contentType: input.contentType,
    metadata: {
      imageId: imageId.toString(),
      ownerType: input.ownerType,
      ...(input.uploadedBy ? { uploadedBy: input.uploadedBy } : {}),
      ...(input.catalog?.provider ? { provider: input.catalog.provider } : {}),
      ...(input.catalog?.entityType ? { entityType: input.catalog.entityType } : {}),
      ...(input.catalog?.externalId ? { externalId: input.catalog.externalId } : {}),
      ...(input.catalog?.size ? { size: input.catalog.size } : {}),
      ...(input.catalog?.sourceUrlHash ? { sourceUrlHash: input.catalog.sourceUrlHash } : {}),
      ...(input.catalog?.sourceContentHash ? { sourceContentHash: input.catalog.sourceContentHash } : {}),
    },
  });

  const doc = await ImageAssetModel.create({
    _id: imageId,
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
    catalog: input.catalog,
  });

  return {
    id: doc._id.toString(),
    s3Key,
  };
}

export async function getImageAssetStream(imageId: string): Promise<{
  stream: Readable;
  contentLength: number;
  contentType?: string;
} | null> {
  if (!mongoose.Types.ObjectId.isValid(imageId)) {
    return null;
  }

  const asset = await ImageAssetModel.findById(imageId).lean();
  if (!asset) {
    return null;
  }

  const result = await streamFromS3(asset.s3Key);
  return {
    stream: result.stream,
    contentLength: result.contentLength,
    contentType: result.contentType ?? asset.contentType,
  };
}

export async function getImageAssetColors(imageId: string): Promise<StoredImageAssetColors | undefined> {
  if (!mongoose.Types.ObjectId.isValid(imageId)) {
    return undefined;
  }

  const asset = await ImageAssetModel.findById(imageId)
    .select('primaryColor secondaryColor')
    .lean();

  if (!asset?.primaryColor) {
    return undefined;
  }

  return {
    primaryColor: asset.primaryColor,
    secondaryColor: asset.secondaryColor,
  };
}

export async function getImageAssetSourceContentHash(imageId: string | undefined): Promise<string | undefined> {
  if (!imageId || !mongoose.Types.ObjectId.isValid(imageId)) {
    return undefined;
  }

  const asset = await ImageAssetModel.findById(imageId)
    .select('catalog.sourceContentHash')
    .lean();
  const sourceContentHash = asset?.catalog?.sourceContentHash;
  return typeof sourceContentHash === 'string' ? sourceContentHash : undefined;
}
