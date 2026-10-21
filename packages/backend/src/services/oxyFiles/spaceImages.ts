/**
 * The images of the live-rooms slice — a house's avatar and cover, a room's
 * stream image, a series' cover — in Oxy Files (OxyHQ/oxy ADR 0043).
 *
 * ## Whose file
 *
 * The space's OWNER's: a house's creator, a room's host, a series' creator. The
 * image belongs to the space the way a store's photos belong to the store's
 * account, so an admin who uploads a house avatar puts it in the house owner's
 * files, not their own — the file must outlive the admin's role, and only the
 * owner can be asked about it later.
 *
 * Each image is a file id column; the DTO hands out the file's public URL.
 */

import { oxyFileUrl } from './client';
import { uploadUserImage, type StoredOxyFile } from './images';

/** The URL to hand a client for one space image, or `null` when it has none. */
export function spaceImageUrl(fileId: string | null | undefined): string | null {
  return fileId ? oxyFileUrl(fileId) : null;
}

/** Store a processed space image in its owner's Oxy account. */
export async function uploadSpaceImage(
  ownerOxyUserId: string,
  image: { buffer: Buffer; contentType: string },
  originalName: string,
): Promise<StoredOxyFile> {
  return uploadUserImage(ownerOxyUserId, image.buffer, image.contentType, originalName);
}
