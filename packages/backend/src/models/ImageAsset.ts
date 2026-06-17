import mongoose, { Schema, Document } from 'mongoose';
import type { CatalogSource } from '@syra/shared-types';

export type ImageAssetOwnerType = 'upload' | 'artist' | 'track' | 'album' | 'playlist' | 'link';

export interface ImageAssetCatalogMetadata {
  provider?: CatalogSource;
  entityType?: 'artist' | 'track' | 'album' | 'playlist';
  externalId?: string;
  size?: string;
  sourceUrlHash?: string;
  sourceContentHash?: string;
}

export interface IImageAsset extends Document {
  _id: mongoose.Types.ObjectId;
  s3Key: string;
  filename: string;
  contentType: string;
  byteSize: number;
  width?: number;
  height?: number;
  ownerType: ImageAssetOwnerType;
  uploadedBy?: string;
  primaryColor?: string;
  secondaryColor?: string;
  catalog?: ImageAssetCatalogMetadata;
  createdAt: Date;
  updatedAt: Date;
}

const CatalogMetadataSchema = new Schema<ImageAssetCatalogMetadata>({
  provider: { type: String, enum: ['upload', 'cc', 'audius'] as CatalogSource[] },
  entityType: { type: String, enum: ['artist', 'track', 'album', 'playlist'] },
  externalId: { type: String },
  size: { type: String },
  sourceUrlHash: { type: String },
  sourceContentHash: { type: String },
}, { _id: false });

const ImageAssetSchema = new Schema<IImageAsset>({
  s3Key: { type: String, required: true, unique: true, index: true },
  filename: { type: String, required: true },
  contentType: { type: String, required: true },
  byteSize: { type: Number, required: true },
  width: { type: Number },
  height: { type: Number },
  ownerType: { type: String, enum: ['upload', 'artist', 'track', 'album', 'playlist', 'link'], required: true, index: true },
  uploadedBy: { type: String, index: true },
  primaryColor: { type: String },
  secondaryColor: { type: String },
  catalog: { type: CatalogMetadataSchema },
}, {
  timestamps: true,
});

ImageAssetSchema.index({ 'catalog.provider': 1, 'catalog.entityType': 1, 'catalog.externalId': 1, 'catalog.size': 1 });
ImageAssetSchema.index({ 'catalog.sourceContentHash': 1 });

export const ImageAssetModel: mongoose.Model<IImageAsset> =
  (mongoose.models.ImageAsset as mongoose.Model<IImageAsset>) ??
  mongoose.model<IImageAsset>('ImageAsset', ImageAssetSchema);
