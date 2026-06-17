import type { TrackImage } from '@syra/shared-types';

export function usableImages(images: TrackImage[] | undefined): TrackImage[] {
  return (images ?? []).filter((image) => typeof image.url === 'string' && image.url.trim().length > 0);
}

export function firstUsableImageUrl(images: TrackImage[] | undefined): string | undefined {
  return usableImages(images)[0]?.url;
}

export function hasUsableImages(images: TrackImage[] | undefined): boolean {
  return firstUsableImageUrl(images) !== undefined;
}
