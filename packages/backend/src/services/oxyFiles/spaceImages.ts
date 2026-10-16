/**
 * The images of the live-rooms slice — a house's avatar and cover, a room's
 * stream image, a series' cover — in Oxy Files (OxyHQ/oxy ADR 0041).
 *
 * ## Whose file
 *
 * The space's OWNER's: a house's creator, a room's host, a series' creator. The
 * image belongs to the space the way a store's photos belong to the store's
 * account, so an admin who uploads a house avatar puts it in the house owner's
 * files, not their own — the file must outlive the admin's role, and only the
 * owner can be asked about it later.
 *
 * ## Dual read
 *
 * Each image is a file id column beside the legacy bucket URL column. The file id
 * wins; the URL is read only when there is none, and a URL pointing into Syra's
 * bucket is counted as a legacy read (`legacyReads.ts`) — the count the bucket's
 * retirement waits on. A URL pointing anywhere else (a stream's own thumbnail, a
 * client-supplied link) was never Syra's to store and is passed through
 * uncounted.
 */

import type { LegacyImageReadKind } from '../../db/schema/oxyFiles';
import { cdnUrlToKey } from '../../utils/spaces';
import { oxyFileUrl } from './client';
import { recordLegacyRead } from './legacyReads';
import { uploadUserImage, type StoredOxyFile } from './images';

/** The URL to hand a client for one space image: the Oxy file first, the legacy URL otherwise. */
export function spaceImageUrl(
  fileId: string | null | undefined,
  legacyUrl: string | null | undefined,
  kind: LegacyImageReadKind,
): string | null {
  if (fileId) return oxyFileUrl(fileId);
  if (!legacyUrl) return null;
  if (cdnUrlToKey(legacyUrl) !== null) recordLegacyRead(kind);
  return legacyUrl;
}

/** Store a processed space image in its owner's Oxy account. */
export async function uploadSpaceImage(
  ownerOxyUserId: string,
  image: { buffer: Buffer; contentType: string },
  originalName: string,
): Promise<StoredOxyFile> {
  return uploadUserImage(ownerOxyUserId, image.buffer, image.contentType, originalName);
}
