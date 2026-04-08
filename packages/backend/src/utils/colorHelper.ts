import { extractPredominantColors, extractPredominantColorsFromBuffer } from '../services/colorExtractionService';
import { logger } from './logger';

/**
 * Helper function to extract primary and secondary colors from either a file buffer or URL
 * 
 * @param imageFile - Optional file buffer from multer upload
 * @param imageUrl - Optional image URL
 * @returns Object with primary and optional secondary color, or undefined if extraction fails
 */
export async function extractColorsFromImage(
  imageFile?: Express.Multer.File,
  imageUrl?: string | null
): Promise<{ primaryColor?: string; secondaryColor?: string } | undefined> {
  // Skip blob URLs - they're temporary local URLs and can't be processed
  if (imageUrl && imageUrl.startsWith('blob:')) {
    logger.debug('[ColorHelper] Skipping blob URL for color extraction');
    return undefined;
  }

  try {
    // Prefer file buffer if available (faster, no download needed)
    if (imageFile && imageFile.buffer) {
      logger.debug('[ColorHelper] Extracting colors from file buffer');
      const colors = await extractPredominantColorsFromBuffer(imageFile.buffer);
      return {
        primaryColor: colors.primary,
        secondaryColor: colors.secondary,
      };
    }

    // Fall back to URL if provided
    if (imageUrl && typeof imageUrl === 'string' && imageUrl.trim().length > 0) {
      logger.debug('[ColorHelper] Extracting colors from URL:', imageUrl);
      const colors = await extractPredominantColors(imageUrl);
      return {
        primaryColor: colors.primary,
        secondaryColor: colors.secondary,
      };
    }

    return undefined;
  } catch (error) {
    logger.warn('[ColorHelper] Failed to extract colors:', {
      error: error instanceof Error ? error.message : String(error),
      hasFile: !!imageFile,
      hasUrl: !!imageUrl,
    });
    // Return undefined on error - don't block the upload process
    return undefined;
  }
}





