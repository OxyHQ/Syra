/**
 * The `image_assets` store — Syra's id for every image it serves.
 *
 * ## Where the bytes are
 *
 * In Oxy Files (OxyHQ/oxy ADR 0043) for every image written since the move —
 * `services/oxyFiles/images.ts` explains who owns which — and, for the rows the
 * migration has not copied yet, still in Syra's own bucket (`s3_key`). A row
 * holds one or both; {@link resolveImageAsset} reads the Oxy file FIRST and falls
 * back to the bucket, counting every fallback (`oxyFiles/legacyReads.ts`). When
 * that count has been zero long enough, the bucket's image prefixes are retired
 * (`docs/runbooks/oxy-files-images.md`) and the fallback goes with them.
 *
 * Nothing new is written to the bucket. There is no second write path to fall
 * back to: a store that cannot reach Oxy fails, loudly, rather than creating a
 * row the migration would have to find later.
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

import type { Readable } from 'stream';
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
import { recordLegacyRead } from './oxyFiles/legacyReads';
import { streamFromS3 } from './s3Service';

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
  const pixels = input.pixels ?? (await measureImage(input.buffer));
  const file =
    input.uploadedBy === undefined
      ? await uploadAppImage(input.buffer, input.contentType, input.filename)
      : await uploadUserImage(input.uploadedBy, input.buffer, input.contentType, input.filename);

  const { id } = await insertOxyImage({
    file,
    pixels,
    ownerType: input.ownerType,
    ...(input.uploadedBy === undefined ? {} : { uploadedBy: input.uploadedBy }),
    filename: input.filename,
  });
  return { id, fileId: file.id, pixels };
}

/** Opens a legacy bucket object. The S3 layer in production; a double in tests. */
export type LegacyImageReader = (key: string) => Promise<{
  stream: Readable;
  contentLength: number;
  contentType?: string;
}>;

let legacyReader: LegacyImageReader = (key) => streamFromS3(key);

export function setLegacyImageReaderForTests(reader: LegacyImageReader | null): void {
  legacyReader = reader ?? ((key) => streamFromS3(key));
}

/** How `GET /api/images/:id` answers for one row. */
export type ResolvedImageAsset =
  | { kind: 'oxy'; url: string }
  | {
      kind: 'legacy';
      stream: Readable;
      contentLength: number;
      contentType?: string;
    }
  | { kind: 'unavailable' };

/**
 * Where an image's bytes are: the Oxy file first, the legacy bucket object only
 * when there is no file yet. `null` for an id that names no row.
 *
 * An Oxy-backed row is answered with its public URL — the client is redirected
 * to Oxy's CDN rather than proxied through Syra. A row Oxy has said it will not
 * serve (`serving_status` other than `active`) is `unavailable`, never a stale
 * copy from the bucket: a taken-down image must not come back through the
 * fallback.
 */
export async function resolveImageAsset(imageId: string): Promise<ResolvedImageAsset | null> {
  // No id-shape pre-check: `image_assets.id` is `text`, so a malformed id
  // simply matches no row and the query answers the question a guard used to.
  const [asset] = await getDb()
    .select({
      s3Key: imageAssets.s3Key,
      oxyFileId: imageAssets.oxyFileId,
      oxyVariant: imageAssets.oxyVariant,
      servingStatus: imageAssets.servingStatus,
      contentType: imageAssets.contentType,
    })
    .from(imageAssets)
    .where(eq(imageAssets.id, imageId))
    .limit(1);

  if (!asset) return null;
  if (asset.servingStatus !== 'active') return { kind: 'unavailable' };
  if (asset.oxyFileId !== null) {
    return { kind: 'oxy', url: oxyFileUrl(asset.oxyFileId, asset.oxyVariant) };
  }
  if (asset.s3Key === null) return { kind: 'unavailable' };

  recordLegacyRead('image_asset');
  const result = await legacyReader(asset.s3Key);
  return {
    kind: 'legacy',
    stream: result.stream,
    contentLength: result.contentLength,
    contentType: result.contentType ?? asset.contentType,
  };
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
