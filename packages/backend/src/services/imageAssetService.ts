import type { RequesterProof } from '@oxy.so/core/server';
/**
 * The `image_assets` store — Syra's id for every image it serves.
 *
 * ## Where the bytes are

 * In Oxy Files (OxyHQ/oxy ADR 0043), always — `services/oxyFiles/images.ts`
 * explains who owns which. Every row names its Oxy file (`oxy_file_id`, NOT
 * NULL); the bucket copies Syra kept while the images migrated are gone, with
 * the column that named them (`docs/runbooks/oxy-files-images.md`).
 *
 * There is no second store to fall back to: a write that cannot reach Oxy
 * fails, loudly.
 *
 * ## Ordering: the file first, then the row
 *
 * An upload that succeeds and an insert that then fails leaves a file no row
 * names. For Syra's own files that is the case Oxy's garbage collection exists
 * for — an application file nobody references is trashed after 24 hours and
 * purged 30 days later. For a person's upload it is a file in their account
 * that nothing uses, which Oxy shows them as "Not in use"; it is theirs to keep
 * or delete, exactly as ADR 0043 D5 decides.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { imageAssets, type ImageAssetOwnerType } from '../db/schema/catalog';
import { oxyFileUrl } from './oxyFiles/client';
import {
  insertOxyImage,
  measureImage,
  uploadAppImage,
  uploadUserImage,
  type ImagePixels,
} from './oxyFiles/images';

export interface StoreImageAssetInput {
  buffer: Buffer;
  filename: string;
  contentType: string;
  ownerType: ImageAssetOwnerType;
  /**
   * The Oxy account whose upload this is. Decides the OWNER: present, the file is
   * stored in that person's account; absent, Syra owns it.
   */
  uploadedBy?: string;
  /** Transient proof, never stored in image metadata. Required for personal uploads. */
  requester?: RequesterProof;
  /** Already measured by the caller; measured here otherwise. */
  pixels?: ImagePixels;
}

export interface StoredImageAssetColors {
  primaryColor?: string;
  secondaryColor?: string;
}

/**
 * Store an image a caller holds the bytes of, as ONE `image_assets` row (the
 * original). Catalogue artwork fetched by URL does not come through here: it is
 * imported by Oxy (`services/catalog/catalogImageAssets.ts`).
 */
export async function storeImageAsset(input: StoreImageAssetInput): Promise<{
  id: string;
  fileId: string;
  pixels: ImagePixels;
}> {
  if (input.uploadedBy && (!input.requester || input.requester.accountId !== input.uploadedBy)) {
    throw new Error('Personal image requires its original requester account proof');
  }
  const pixels = input.pixels ?? (await measureImage(input.buffer));
  const file =
    input.uploadedBy === undefined
      ? await uploadAppImage(input.buffer, input.contentType, input.filename)
      : await uploadUserImage(
          input.uploadedBy,
          input.buffer,
          input.contentType,
          input.filename,
          input.requester!,
        );

  const { id } = await insertOxyImage({
    file,
    pixels,
    ownerType: input.ownerType,
    ...(input.uploadedBy === undefined ? {} : { uploadedBy: input.uploadedBy }),
    filename: input.filename,
  });
  return { id, fileId: file.id, pixels };
}

/** How `GET /api/images/:id` answers for one row. */
export type ResolvedImageAsset = { kind: 'oxy'; url: string } | { kind: 'unavailable' };

/**
 * Where an image's bytes are: its Oxy file's public URL — the client is
 * redirected to Oxy's CDN rather than proxied through Syra. `null` for an id
 * that names no row; `unavailable` for a row Oxy has said it will not serve
 * (`serving_status` other than `active`).
 */
export async function resolveImageAsset(imageId: string): Promise<ResolvedImageAsset | null> {
  // No id-shape pre-check: `image_assets.id` is `text`, so a malformed id
  // simply matches no row and the query answers the question a guard used to.
  const [asset] = await getDb()
    .select({
      oxyFileId: imageAssets.oxyFileId,
      oxyVariant: imageAssets.oxyVariant,
      servingStatus: imageAssets.servingStatus,
    })
    .from(imageAssets)
    .where(eq(imageAssets.id, imageId))
    .limit(1);

  if (!asset) return null;
  if (asset.servingStatus !== 'active') return { kind: 'unavailable' };
  return { kind: 'oxy', url: oxyFileUrl(asset.oxyFileId, asset.oxyVariant) };
}

export async function getImageAssetColors(
  imageId: string,
): Promise<StoredImageAssetColors | undefined> {
  const [asset] = await getDb()
    .select({
      primaryColor: imageAssets.primaryColor,
      secondaryColor: imageAssets.secondaryColor,
    })
    .from(imageAssets)
    .where(eq(imageAssets.id, imageId))
    .limit(1);

  // `secondaryColor` alone is not a palette — the whole result is keyed on
  // `primaryColor` being present.
  if (!asset?.primaryColor) return undefined;

  return {
    primaryColor: asset.primaryColor,
    secondaryColor: asset.secondaryColor ?? undefined,
  };
}
