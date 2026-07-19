import { argbFromRgb, seedHexFromImagePixels } from '@oxyhq/bloom/theme';

/**
 * Extract the dominant seed colour (`#rrggbb`) from an artwork image on web.
 *
 * Draws the image to a small (~96×96) offscreen canvas, reads back the pixels,
 * packs each as an ARGB int, and runs Bloom's colour-engine image quantizer
 * (`seedHexFromImagePixels`) to pick the most theme-suitable seed. Extraction is
 * deterministic for a given image, so callers can cache the result per artwork.
 *
 * Returns `null` (never throws) when extraction is not possible — no canvas
 * support, the image fails to load, or the canvas is CORS-tainted so
 * `getImageData` is blocked. The caller then keeps the app preset.
 */
const SAMPLE_SIZE = 96;

export async function extractArtworkSeed(imageUrl: string): Promise<string | null> {
  if (!canExtractArtworkSeed() || !imageUrl) return null;

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

  try {
    return seedHexFromImagePixels(pixels);
  } catch {
    return null;
  }
}

/** Whether the current environment can extract a seed from an image. */
export function canExtractArtworkSeed(): boolean {
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
