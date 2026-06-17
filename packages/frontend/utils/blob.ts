/**
 * Blob utility module using expo-blob
 * 
 * expo-blob provides a web standards-compliant Blob implementation for React Native
 * that offers superior performance and works consistently across all platforms.
 * It is more reliable compared to the implementation exported from react-native,
 * especially with the slice() method and other Web API features.
 * 
 * Usage:
 *   import { Blob } from '@/utils/blob';
 *   
 *   // Create a blob from text
 *   const blob = new Blob(['Hello, World!'], { type: 'text/plain' });
 *   const text = await blob.text();
 *   
 *   // Create a blob from binary data
 *   const binaryBlob = new Blob([new Uint8Array([1, 2, 3, 4])], {
 *     type: 'application/octet-stream',
 *   });
 *   
 *   // Slice a blob
 *   const slice = blob.slice(0, 5);
 *   const slicedText = await slice.text();
 */

import { Blob as ExpoBlob } from 'expo-blob';

/**
 * Blob implementation using expo-blob
 * 
 * expo-blob works on both web and native platforms, providing:
 * - Web standards-compliant implementation
 * - Superior performance compared to React Native's Blob
 * - Consistent behavior across all platforms
 * - Proper slice() method support (unlike React Native's Blob)
 */
export { ExpoBlob as Blob };
export type ExpoBlobInstance = InstanceType<typeof ExpoBlob>;

type IterableItem<T> = T extends Iterable<infer Item> ? Item : never;
type ExpoBlobParts = NonNullable<ConstructorParameters<typeof ExpoBlob>[0]>;

/**
 * BlobPart represents the values accepted by expo-blob's Blob constructor.
 */
export type BlobPart = IterableItem<ExpoBlobParts>;

/**
 * Helper function to create a Blob from text
 */
export function createTextBlob(text: string, mimeType: string = 'text/plain'): ExpoBlobInstance {
  return new ExpoBlob([text], { type: mimeType });
}

/**
 * Helper function to create a Blob from binary data
 */
export function createBinaryBlob(
  data: ArrayBuffer | Uint8Array | ArrayBufferView | BlobPart,
  mimeType: string = 'application/octet-stream'
): ExpoBlobInstance {
  return new ExpoBlob([data], { type: mimeType });
}

/**
 * Helper function to create a Blob from mixed content
 */
export function createMixedBlob(
  parts: BlobPart[],
  mimeType: string = ''
): ExpoBlobInstance {
  return new ExpoBlob(parts, { type: mimeType });
}

/**
 * Helper function to check if a value is a Blob
 */
export function isBlob(value: unknown): value is ExpoBlobInstance {
  return value instanceof ExpoBlob;
}

/**
 * Helper function to get blob info
 */
export function getBlobInfo(blob: ExpoBlobInstance | globalThis.Blob): { size: number; type: string } {
  return {
    size: blob.size,
    type: blob.type,
  };
}

/**
 * Check if a string is a blob URL
 */
export function isBlobUrl(url: string): boolean {
  return typeof url === 'string' && url.startsWith('blob:');
}

/**
 * Create a blob URL from a File or Blob object using expo-blob
 * Works on both web and native platforms
 * 
 * @param fileOrBlob - File or Blob object (expo-blob Blob works on all platforms)
 * @param originalUri - Fallback URI if blob URL creation fails or on unsupported platforms
 * @returns Blob URL when supported, otherwise original URI
 */
export function createBlobUrl(fileOrBlob: File | globalThis.Blob, originalUri?: string): string {
  // URL.createObjectURL is available on web platforms
  if (typeof window !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
    try {
      return URL.createObjectURL(fileOrBlob);
    } catch (error) {
      console.error('Failed to create blob URL:', error);
      return originalUri || '';
    }
  }
  
  // On native or unsupported platforms, return original URI
  return originalUri || '';
}

/**
 * Revoke a blob URL to free memory
 * Safe to call on non-blob URLs or every supported platform
 * 
 * @param url - Blob URL to revoke
 */
export function revokeBlobUrl(url: string | null | undefined): void {
  if (!url || typeof window === 'undefined' || typeof URL === 'undefined' || !URL.revokeObjectURL) {
    return;
  }
  
  if (isBlobUrl(url)) {
    try {
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to revoke blob URL:', error);
    }
  }
}
