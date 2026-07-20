import { argbFromRgb, hexFromArgb, seedsFromImagePixels } from '@oxyhq/bloom/theme';

import type { ArtworkSeeds } from './artworkSeed.types';

/**
 * Extract the top-3 seed colours from an artwork image on web.
 *
 * Draws the image to a small (~96×96) offscreen canvas, reads back the pixels,
 * packs each as an ARGB int, and runs Bloom's colour-engine image quantizer
 * (`seedsFromImagePixels`, ranked best-first) to pick the most theme-suitable
 * seeds. The top result becomes the app-wide `seed`; the 2nd/3rd (when present)
 * become the pinned `secondarySeed` / `tertiarySeed` accents so the theme
 * reflects the artwork's real supporting colours instead of hue-rotations.
 * Extraction is deterministic for a given image, so callers can cache the result
 * per artwork.
 *
 * Returns `null` (never throws) when extraction is not possible — no canvas
 * support, the image fails to load, or the canvas is CORS-tainted so
 * `getImageData` is blocked. The caller then keeps the app preset.
 */
const SAMPLE_SIZE = 96;

export async function extractArtworkSeeds(imageUrl: string): Promise<ArtworkSeeds | null> {
  if (!canExtractArtworkSeeds() || !imageUrl) return null;

  const image = await loadImage(imageUrl);
  if (!image) return null;

  const canvas = document.createElement('canvas');
  const width = Math.max(1, Math.min(SAMPLE_SIZE, image.naturalWidth || SAMPLE_SIZE));
  const height = Math.max(1, Math.min(SAMPLE_SIZE, image.naturalHeight || SAMPLE_SIZE));
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  context.drawImage(image, 0, 0, width, height);

  let data: Uint8ClampedArray;
  try {
    // Throws a SecurityError if the canvas is tainted (cross-origin image
    // served without permissive CORS headers). Treated as "no seed".
    data = context.getImageData(0, 0, width, height).data;
  } catch {
    return null;
  }

  const pixels: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    // Skip fully/near-transparent pixels — they are not part of the artwork.
    if (alpha < 125) continue;
    pixels.push(argbFromRgb(data[i], data[i + 1], data[i + 2]));
  }
  if (pixels.length === 0) return null;

  let seeds: number[];
  try {
    // Ranked best-first; ask for up to 3 so we can pin secondary/tertiary accents.
    seeds = seedsFromImagePixels(pixels, { desired: 3 });
  } catch {
    return null;
  }
  if (seeds.length === 0) return null;

  return {
    seed: hexFromArgb(seeds[0]),
    secondarySeed: seeds.length > 1 ? hexFromArgb(seeds[1]) : undefined,
    tertiarySeed: seeds.length > 2 ? hexFromArgb(seeds[2]) : undefined,
  };
}

/** Whether the current environment can extract seeds from an image. */
export function canExtractArtworkSeeds(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    // Request CORS so the canvas stays untainted when the server allows it.
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}
