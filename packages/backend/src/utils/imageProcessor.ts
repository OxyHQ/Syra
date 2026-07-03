import sharp from 'sharp';

/**
 * Server-side image normalization for the live-rooms slice (room / house /
 * series images). Every uploaded image is decoded, resized to a fixed preset,
 * and re-encoded as WebP — the client never controls the stored format or
 * dimensions. Backed by `sharp` (Syra's image library).
 */

type ImagePreset = 'avatar' | 'cover' | 'roomImage';

const PRESETS: Record<ImagePreset, { width: number; height: number; quality: number }> = {
  avatar: { width: 400, height: 400, quality: 80 },
  cover: { width: 1200, height: 630, quality: 85 },
  roomImage: { width: 800, height: 450, quality: 80 },
};

/**
 * Hard cap on input dimensions. Beyond `sharp`'s built-in pixel-count guard,
 * this rejects absurdly large source images before any resize work.
 */
const MAX_INPUT_DIMENSION = 10000;

export async function processImage(
  input: Buffer,
  preset: ImagePreset,
): Promise<{ buffer: Buffer; contentType: string }> {
  const { width, height, quality } = PRESETS[preset];

  // `failOn: 'error'` rejects truncated/corrupt payloads; sharp also enforces a
  // default `limitInputPixels` cap that guards against decompression bombs.
  const pipeline = sharp(input, { failOn: 'error' });
  const metadata = await pipeline.metadata();
  if (
    (metadata.width ?? 0) > MAX_INPUT_DIMENSION ||
    (metadata.height ?? 0) > MAX_INPUT_DIMENSION
  ) {
    throw new Error('Input image dimensions exceed the allowed maximum');
  }

  const buffer = await pipeline
    .resize(width, height, { fit: 'cover' })
    .webp({ quality })
    .toBuffer();

  return { buffer, contentType: 'image/webp' };
}
