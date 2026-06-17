import mongoose from 'mongoose';
import { findFiles } from './mongoose-gridfs';

export interface StoredImageColors {
  primaryColor?: string;
  secondaryColor?: string;
}

function metadataColors(metadata: unknown): StoredImageColors | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const primaryColor = (metadata as { primaryColor?: unknown }).primaryColor;
  const secondaryColor = (metadata as { secondaryColor?: unknown }).secondaryColor;
  if (typeof primaryColor !== 'string' || primaryColor.length === 0) return undefined;
  return {
    primaryColor,
    secondaryColor: typeof secondaryColor === 'string' && secondaryColor.length > 0 ? secondaryColor : undefined,
  };
}

export async function getStoredImageColors(imageId: string): Promise<StoredImageColors | undefined> {
  if (!mongoose.Types.ObjectId.isValid(imageId)) return undefined;

  const files = await findFiles({ _id: new mongoose.Types.ObjectId(imageId) });
  const file = files[0];
  return metadataColors(file?.metadata);
}
