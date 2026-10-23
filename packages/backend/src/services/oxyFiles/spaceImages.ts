/** Shared space artwork belongs to the application resource, not its admin's or
 * owner's personal Files account. Local house/room/series roles still authorize
 * replacement; reference triggers release the old file without deleting it. */

import { oxyFileUrl } from './client';
import { uploadAppImage, type StoredOxyFile } from './images';

/** The URL to hand a client for one space image, or `null` when it has none. */
export function spaceImageUrl(fileId: string | null | undefined): string | null {
  return fileId ? oxyFileUrl(fileId) : null;
}

/** Store a new shared resource asset; historical personal file IDs stay unchanged. */
export async function uploadSpaceImage(
  image: { buffer: Buffer; contentType: string },
  originalName: string,
): Promise<StoredOxyFile> {
  return uploadAppImage(image.buffer, image.contentType, originalName);
}
