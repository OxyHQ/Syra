import type { TrackImage } from '@syra/shared-types';
import { tryExtractPredominantColors } from '../colorExtractionService';

export interface EntityColors {
  primaryColor?: string;
  secondaryColor?: string;
}

export interface EntityColorTarget {
  primaryColor?: string;
  secondaryColor?: string;
}

export function firstImageUrl(images: TrackImage[] | undefined): string | undefined {
  return images?.find((image) => typeof image.url === 'string' && image.url.length > 0)?.url;
}

export async function colorsFromImages(
  images: TrackImage[] | undefined,
): Promise<EntityColors | undefined> {
  const imageUrl = firstImageUrl(images);
  if (!imageUrl) return undefined;
  const colors = await tryExtractPredominantColors(imageUrl);
  if (!colors) return undefined;
  return {
    primaryColor: colors.primary,
    secondaryColor: colors.secondary,
  };
}

export function assignMissingColors(
  target: EntityColorTarget,
  colors: EntityColors | undefined,
): void {
  if (colors?.primaryColor && !target.primaryColor) {
    target.primaryColor = colors.primaryColor;
  }
  if (colors?.secondaryColor && !target.secondaryColor) {
    target.secondaryColor = colors.secondaryColor;
  }
}
