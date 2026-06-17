import { getImageAssetColors } from '../services/imageAssetService';

export interface StoredImageColors {
  primaryColor?: string;
  secondaryColor?: string;
}

export async function getStoredImageColors(imageId: string): Promise<StoredImageColors | undefined> {
  return getImageAssetColors(imageId);
}
