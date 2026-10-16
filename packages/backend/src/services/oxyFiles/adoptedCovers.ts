/**
 * A show cover that is ALREADY an Oxy file — `imageFileId` on `POST`/`PATCH
 * /api/podcasts`.
 *
 * The case it exists for is Alia: Alia draws a show's cover, so the cover is
 * Alia's file (OxyHQ/oxy ADR 0041 phase 4 moved Alia's covers out of Syra), and
 * Syra only USES it. Syra therefore never copies it: it checks the file, records
 * its own reference (entity `podcast`), and gives it an `image_assets` set like
 * any other image, so every DTO, the RSS feed and `/api/images/:id` treat it the
 * same way.
 *
 * ## Who may hand Syra a file
 *
 * A caller may use a file only if it is theirs to use, decided from Oxy's own
 * record of the owner (`metadataByIds`, which names the owner to an Oxy-internal
 * service token like Syra's) — never from the request:
 *
 * - a file in the CALLER's own account; or
 * - a file owned by an application Syra trusts to supply covers
 *   (`SYRA_COVER_APPLICATION_IDS`, Alia's application id). Empty means none.
 *
 * And it must be an active image Syra can reference — which the reference itself
 * proves: Oxy refuses a reference to a private file that is not Syra's, and that
 * refusal is answered as an unusable file. A file passing all of it is served
 * from Oxy's CDN like every other.
 */

import type { CatalogImageSizes } from '@syra/shared-types';
import { oxyFiles } from './client';
import { findOxyImageSet, insertOxyImageSet, measureOxyFile } from './images';

export type AdoptCoverRefusal = 'unknown_file' | 'not_an_image' | 'not_yours' | 'not_referenceable';

export type AdoptedCover =
  | {
      ok: true;
      imageId: string;
      imageSizes: CatalogImageSizes;
      primaryColor?: string;
      secondaryColor?: string;
    }
  | { ok: false; reason: AdoptCoverRefusal };

/** The applications whose files a caller may name as a cover. */
export function trustedCoverApplicationIds(): ReadonlySet<string> {
  return new Set(
    (process.env.SYRA_COVER_APPLICATION_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

export async function adoptCoverFile(
  fileId: string,
  caller: { oxyUserId: string; podcastId: string },
): Promise<AdoptedCover> {
  const [meta] = await oxyFiles().metadataByIds([fileId]);
  if (!meta || meta.id !== fileId || meta.status !== 'active') {
    return { ok: false, reason: 'unknown_file' };
  }
  if (!meta.mime.startsWith('image/')) return { ok: false, reason: 'not_an_image' };

  const ownedByCaller = meta.ownerUserId === caller.oxyUserId;
  const ownedByTrustedApp =
    meta.ownerApplicationId !== undefined &&
    trustedCoverApplicationIds().has(meta.ownerApplicationId);
  if (!ownedByCaller && !ownedByTrustedApp) return { ok: false, reason: 'not_yours' };

  // Recorded now, before the row that will use it: it is what proves Syra may
  // use the file at all. The trigger queues the same reference when the row is
  // written; a duplicate is answered `exists`. A row that is then never written
  // leaves a reference the nightly reconciliation removes.
  const [reference] = await oxyFiles().references.add([
    { fileId, entityType: 'podcast', entityId: caller.podcastId },
  ]);
  if (!reference || (reference.result !== 'created' && reference.result !== 'exists')) {
    return { ok: false, reason: 'not_referenceable' };
  }

  const existing = await findOxyImageSet(fileId);
  if (existing) {
    return {
      ok: true,
      imageId: existing.imageId,
      imageSizes: existing.imageSizes,
      ...(existing.primaryColor ? { primaryColor: existing.primaryColor } : {}),
      ...(existing.secondaryColor ? { secondaryColor: existing.secondaryColor } : {}),
    };
  }

  const pixels = await measureOxyFile(fileId);
  const set = await insertOxyImageSet({
    file: { id: meta.id, sha256: meta.sha256, size: meta.size, mime: meta.mime },
    pixels,
    ownerType: 'podcast',
    ...(ownedByCaller ? { uploadedBy: caller.oxyUserId } : {}),
    filename: `cover-${fileId}`,
  });
  return {
    ok: true,
    imageId: set.imageId,
    imageSizes: set.imageSizes,
    ...(set.primaryColor ? { primaryColor: set.primaryColor } : {}),
    ...(set.secondaryColor ? { secondaryColor: set.secondaryColor } : {}),
  };
}
