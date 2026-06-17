import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import sharp from 'sharp';
import { logger } from '../utils/logger';
import { validateUrlSecurity } from '../utils/urlSecurity';

/**
 * Service to extract dominant colors from images
 * Uses sharp to analyze images and extract the most prominent colors
 */

const TIMEOUT_MS = 10000; // 10 seconds
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const FALLBACK_COLOR = '#808080'; // Gray fallback color
const MIN_COLOR_DIFFERENCE = 50; // Minimum difference in brightness or color distance for secondary color

/**
 * Convert RGB values to hex color string
 */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => {
    const hex = Math.round(Math.max(0, Math.min(255, n))).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Calculate color distance between two RGB colors (Euclidean distance)
 */
function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt(Math.pow(r1 - r2, 2) + Math.pow(g1 - g2, 2) + Math.pow(b1 - b2, 2));
}

/**
 * Calculate brightness of an RGB color
 */
function calculateBrightness(r: number, g: number, b: number): number {
  return r * 0.299 + g * 0.587 + b * 0.114;
}

/**
 * Download image from URL
 */
async function downloadImage(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Skip blob URLs - they're temporary local URLs and can't be downloaded
    if (url.startsWith('blob:')) {
      return reject(new Error('Blob URLs are not supported for color extraction'));
    }

    // Security check
    const securityCheck = validateUrlSecurity(url);
    if (!securityCheck.valid) {
      return reject(new Error(securityCheck.error || 'URL security validation failed'));
    }

    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'image/*',
      },
      timeout: TIMEOUT_MS,
    };

    const req = client.request(options, (res) => {
      // Check content type
      const contentType = res.headers['content-type'] || '';
      if (!contentType.startsWith('image/')) {
        return reject(new Error('URL does not point to an image'));
      }

      // Check content length
      const contentLength = parseInt(res.headers['content-length'] || '0', 10);
      if (contentLength > 10 * 1024 * 1024) { // 10MB limit
        return reject(new Error('Image too large'));
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        totalSize += chunk.length;
        
        // Prevent memory issues
        if (totalSize > 10 * 1024 * 1024) { // 10MB limit
          res.destroy();
          return reject(new Error('Image too large'));
        }
      });

      res.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

/**
 * Extract predominant colors (primary and secondary) from image buffer
 * Uses sharp to resize and get color statistics
 */
async function extractPredominantColorsFromBufferInternal(imageBuffer: Buffer): Promise<{ primary: string; secondary?: string }> {
  try {
    // Resize image to smaller size for faster processing (max 100x100)
    // This is sufficient for color extraction and much faster
    const resized = await sharp(imageBuffer)
      .resize(100, 100, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = resized;
    const { width, height, channels } = info;

    // Calculate color frequencies
    const colorMap = new Map<string, { count: number; r: number; g: number; b: number }>();
    
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      // Round to reduce color space (group similar colors)
      const roundedR = Math.round(r / 8) * 8;
      const roundedG = Math.round(g / 8) * 8;
      const roundedB = Math.round(b / 8) * 8;
      
      const colorKey = `${roundedR},${roundedG},${roundedB}`;
      const existing = colorMap.get(colorKey);
      if (existing) {
        existing.count += 1;
      } else {
        colorMap.set(colorKey, { count: 1, r: roundedR, g: roundedG, b: roundedB });
      }
    }

    // Sort colors by frequency, excluding very dark/light colors
    const validColors: Array<{ r: number; g: number; b: number; count: number; brightness: number }> = [];
    
    for (const [_, colorData] of colorMap.entries()) {
      const brightness = calculateBrightness(colorData.r, colorData.g, colorData.b);
      
      // Skip very dark colors (likely shadows/borders)
      if (brightness < 30) continue;
      
      // Skip very light colors (likely backgrounds)
      if (brightness > 240) continue;

      validColors.push({
        r: colorData.r,
        g: colorData.g,
        b: colorData.b,
        count: colorData.count,
        brightness,
      });
    }

    // Sort by frequency (most frequent first)
    validColors.sort((a, b) => b.count - a.count);

    // Default fallback colors
    const defaultPrimary = { r: 128, g: 128, b: 128 };
    const defaultSecondary = { r: 100, g: 100, b: 100 };

    if (validColors.length === 0) {
      return {
        primary: rgbToHex(defaultPrimary.r, defaultPrimary.g, defaultPrimary.b),
        secondary: rgbToHex(defaultSecondary.r, defaultSecondary.g, defaultSecondary.b),
      };
    }

    // Primary color is the most frequent
    const primary = validColors[0];

    // Find secondary color: most frequent color that's sufficiently different from primary
    let secondary: typeof validColors[0] | undefined;
    
    for (let i = 1; i < validColors.length; i++) {
      const candidate = validColors[i];
      
      // Check if colors are sufficiently different
      const brightnessDiff = Math.abs(candidate.brightness - primary.brightness);
      const colorDist = colorDistance(
        candidate.r, candidate.g, candidate.b,
        primary.r, primary.g, primary.b
      );
      
      if (brightnessDiff >= MIN_COLOR_DIFFERENCE || colorDist >= MIN_COLOR_DIFFERENCE) {
        secondary = candidate;
        break;
      }
    }

    // If no sufficiently different color found, use the second most frequent
    if (!secondary && validColors.length > 1) {
      secondary = validColors[1];
    }

    return {
      primary: rgbToHex(primary.r, primary.g, primary.b),
      secondary: secondary ? rgbToHex(secondary.r, secondary.g, secondary.b) : undefined,
    };
  } catch (error) {
    logger.error('[ColorExtractionService] Error extracting colors from buffer:', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Extract dominant color from image buffer (backward compatibility)
 * Uses sharp to resize and get color statistics
 */
async function extractColorFromBuffer(imageBuffer: Buffer): Promise<string> {
  const colors = await extractPredominantColorsFromBufferInternal(imageBuffer);
  return colors.primary;
}

/**
 * Extract predominant colors (primary and secondary) from image URL
 * Downloads the image and extracts its predominant colors
 * 
 * @param imageUrl - URL to the image
 * @returns Object with primary and optional secondary color, or fallback colors on error
 */
export async function extractPredominantColors(imageUrl: string | null | undefined): Promise<{ primary: string; secondary?: string }> {
  if (!imageUrl || typeof imageUrl !== 'string' || imageUrl.trim().length === 0) {
    logger.debug('[ColorExtractionService] No image URL provided, using fallback');
    return {
      primary: FALLBACK_COLOR,
      secondary: undefined,
    };
  }

  try {
    // Download image
    const imageBuffer = await downloadImage(imageUrl);
    
    // Extract colors
    const colors = await extractPredominantColorsFromBufferInternal(imageBuffer);
    
    logger.debug('[ColorExtractionService] Extracted colors:', { imageUrl, colors });
    return colors;
  } catch (error) {
    logger.warn('[ColorExtractionService] Failed to extract colors, using fallback:', {
      imageUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      primary: FALLBACK_COLOR,
      secondary: undefined,
    };
  }
}

/**
 * Extract predominant colors from an image URL without substituting fallback
 * colors. Use this for catalog metadata where persisting a fake color would be
 * worse than leaving colors unset.
 */
export async function tryExtractPredominantColors(
  imageUrl: string | null | undefined,
): Promise<{ primary: string; secondary?: string } | undefined> {
  if (!imageUrl || typeof imageUrl !== 'string' || imageUrl.trim().length === 0) {
    return undefined;
  }

  try {
    const imageBuffer = await downloadImage(imageUrl);
    return extractPredominantColorsFromBufferInternal(imageBuffer);
  } catch (error) {
    logger.warn('[ColorExtractionService] Failed to extract real colors:', {
      imageUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Extract predominant colors from image buffer (exported function)
 * 
 * @param imageBuffer - Image buffer
 * @returns Object with primary and optional secondary color, or fallback colors on error
 */
export async function extractPredominantColorsFromBuffer(imageBuffer: Buffer): Promise<{ primary: string; secondary?: string }> {
  try {
    const colors = await extractPredominantColorsFromBufferInternal(imageBuffer);
    logger.debug('[ColorExtractionService] Extracted colors from buffer:', { colors });
    return colors;
  } catch (error) {
    logger.warn('[ColorExtractionService] Failed to extract colors from buffer, using fallback:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      primary: FALLBACK_COLOR,
      secondary: undefined,
    };
  }
}

/**
 * Extract dominant color from image URL (backward compatibility)
 * Downloads the image and extracts its dominant color
 * 
 * @param imageUrl - URL to the image
 * @returns Hex color string (e.g., "#FF5733") or fallback color on error
 */
export async function extractDominantColor(imageUrl: string | null | undefined): Promise<string> {
  const colors = await extractPredominantColors(imageUrl);
  return colors.primary;
}

/**
 * Extract dominant color from image buffer (backward compatibility)
 * 
 * @param imageBuffer - Image buffer
 * @returns Hex color string (e.g., "#FF5733") or fallback color on error
 */
export async function extractDominantColorFromBuffer(imageBuffer: Buffer): Promise<string> {
  const colors = await extractPredominantColorsFromBuffer(imageBuffer);
  return colors.primary;
}
