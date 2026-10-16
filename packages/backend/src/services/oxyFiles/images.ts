/**
 * Images stored in Oxy Files (OxyHQ/oxy ADR 0043), as `image_assets` rows.
 *
 * An `image_assets` row stays Syra's id for an image — fifty foreign-key columns
 * point at it — but its bytes are an Oxy file. Who owns the file is decided by
 * where the image came from, never by who happens to be asking:
 *
 * - catalogue artwork Syra mirrors (MusicBrainz, Commons, podcast RSS) is
 *   SYRA's: an application-owned file, unbilled, garbage-collected by Oxy once
 *   nothing references it;
 * - a person's upload (cover art, a house avatar, a photo suggestion carried in
 *   their file) is THEIRS: a file in their own Oxy account, which Oxy never
 *   deletes behind their back.
 *
 * A catalogue image is ONE file. Its six sizes are six rows naming the same file
 * and an Oxy rendition each ({@link CATALOG_SIZE_VARIANTS}) — Oxy renders them;
 * Syra no longer resizes, re-encodes or uploads six copies.
 */

import sharp from 'sharp';
import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { IMAGE_VARIANTS, type ImageVariantName } from '@oxy.so/utils/image';
import type { CatalogImageSizes, CatalogImageVariant } from '@syra/shared-types';
import { getDb } from '../../db/postgres';
import {
  imageAssets,
  type CatalogImageEntityType,
  type CatalogImageProvider,
  type ImageAssetOwnerType,
} from '../../db/schema/catalog';
import { extractPredominantColorsFromBuffer } from '../colorExtractionService';
import { oxyFiles, readOxyFile } from './client';

/** The sizes a catalogue image set has, smallest first. */
export const CATALOG_IMAGE_SIZES = [
  'small',
  'medium',
  'large',
  'xlarge',
  'xxlarge',
  'original',
] as const;

export type CatalogImageSize = (typeof CATALOG_IMAGE_SIZES)[number];

/**
 * Which Oxy rendition serves each size: the smallest on Oxy's ladder at least as
 * large as the square Syra used to render (160, 320, 640, 960, 1280 px). Oxy fits
 * an image INSIDE the box and never crops; every client draws artwork with
 * `cover`, so a non-square source still fills its square.
 */
export const CATALOG_SIZE_VARIANTS: Record<CatalogImageSize, ImageVariantName | null> = {
  small: 'thumb',
  medium: 'w320',
  large: 'w640',
  xlarge: 'w1280',
  xxlarge: 'w1280',
  original: null,
};

/** The size whose id stands for the whole set — what `imageId` has always been. */
const PRIMARY_SIZE: CatalogImageSize = 'large';

/** The dimensions Oxy renders `variant` of a `width`×`height` original at. */
export function variantDimensions(
  width: number,
  height: number,
  variant: ImageVariantName | null,
): { width: number; height: number } {
  if (variant === null || width <= 0 || height <= 0) return { width, height };
  const box: { width: number; height?: number } = IMAGE_VARIANTS[variant];
  const scale = Math.min(1, box.width / width, box.height === undefined ? 1 : box.height / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The Oxy file an image is stored as — what an upload, an import or a lookup answers. */
export interface StoredOxyFile {
  id: string;
  sha256: string;
  size: number;
  mime: string;
}

/** What Syra knows about an image's pixels: from the bytes it held, or read back from Oxy. */
export interface ImagePixels {
  width: number;
  height: number;
  primaryColor?: string;
  secondaryColor?: string;
}

export interface CatalogImageProvenance {
  provider: CatalogImageProvider;
  entityType: CatalogImageEntityType;
  externalId: string;
  sourceUrlHash?: string;
}

export interface OxyImageRowInput {
  file: StoredOxyFile;
  pixels: ImagePixels;
  ownerType: ImageAssetOwnerType;
  /** The Oxy account whose upload this is; absent for Syra's own artwork. */
  uploadedBy?: string;
  filename: string;
  catalog?: CatalogImageProvenance;
}

export interface OxyImageSet {
  imageId: string;
  imageSizes: CatalogImageSizes;
  primaryColor?: string;
  secondaryColor?: string;
  sourceUrlHash?: string;
  sourceContentHash: string;
}

/** Measure an image and take its palette, from bytes in hand. */
export async function measureImage(bytes: Buffer): Promise<ImagePixels> {
  const [metadata, colors] = await Promise.all([
    sharp(bytes).metadata(),
    extractPredominantColorsFromBuffer(bytes),
  ]);
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    ...(colors.primary ? { primaryColor: colors.primary } : {}),
    ...(colors.secondary ? { secondaryColor: colors.secondary } : {}),
  };
}

/**
 * Measure an Oxy file Syra does not hold the bytes of — one Oxy imported by URL,
 * or a cover another application made — by reading it back from Oxy's CDN.
 */
export async function measureOxyFile(fileId: string): Promise<ImagePixels> {
  return measureImage(await readOxyFile(fileId));
}

/** One `image_assets` row for an Oxy file: the original, as a person's upload has. */
export async function insertOxyImage(input: OxyImageRowInput): Promise<{ id: string }> {
  const id = uuidv7();
  await getDb()
    .insert(imageAssets)
    .values({
      id,
      oxyFileId: input.file.id,
      oxyVariant: null,
      filename: input.filename,
      contentType: input.file.mime,
      byteSize: input.file.size,
      width: input.pixels.width || null,
      height: input.pixels.height || null,
      ownerType: input.ownerType,
      uploadedBy: input.uploadedBy,
      primaryColor: input.pixels.primaryColor,
      secondaryColor: input.pixels.secondaryColor,
      catalogProvider: input.catalog?.provider,
      catalogEntityType: input.catalog?.entityType,
      catalogExternalId: input.catalog?.externalId,
      catalogSourceUrlHash: input.catalog?.sourceUrlHash,
      catalogSourceContentHash: input.file.sha256,
    });
  return { id };
}

/**
 * The six size rows of a catalogue image, all naming one Oxy file.
 *
 * Rows only — no bytes move. `byte_size` is the original's on every row: Oxy
 * does not report a rendition's size before rendering it, and nothing reads the
 * column for a rendition.
 */
export async function insertOxyImageSet(input: OxyImageRowInput): Promise<OxyImageSet> {
  const { width, height } = input.pixels;
  const rows = CATALOG_IMAGE_SIZES.map((size) => {
    const variant = CATALOG_SIZE_VARIANTS[size];
    const dims = variantDimensions(width, height, variant);
    return {
      size,
      variant,
      row: {
        id: uuidv7(),
        oxyFileId: input.file.id,
        oxyVariant: variant,
        filename: `${input.filename}-${size}`,
        contentType: variant === null ? input.file.mime : 'image/webp',
        byteSize: input.file.size,
        width: dims.width || null,
        height: dims.height || null,
        ownerType: input.ownerType,
        uploadedBy: input.uploadedBy,
        primaryColor: input.pixels.primaryColor,
        secondaryColor: input.pixels.secondaryColor,
        catalogProvider: input.catalog?.provider,
        catalogEntityType: input.catalog?.entityType,
        catalogExternalId: input.catalog?.externalId,
        catalogSize: size,
        catalogSourceUrlHash: input.catalog?.sourceUrlHash,
        catalogSourceContentHash: input.file.sha256,
      },
    };
  });
  await getDb()
    .insert(imageAssets)
    .values(rows.map(({ row }) => row));

  const imageSizes: CatalogImageSizes = {};
  for (const { size, variant, row } of rows) {
    if (row.width === null || row.height === null) continue;
    const entry: CatalogImageVariant = {
      id: row.id,
      url: `/api/images/${row.id}`,
      width: row.width,
      height: row.height,
      fileId: input.file.id,
      ...(variant === null ? {} : { variant }),
    };
    imageSizes[size] = entry;
  }
  const primary = rows.find(({ size }) => size === PRIMARY_SIZE);
  return {
    imageId: primary?.row.id ?? rows[0].row.id,
    imageSizes,
    ...(input.pixels.primaryColor ? { primaryColor: input.pixels.primaryColor } : {}),
    ...(input.pixels.secondaryColor ? { secondaryColor: input.pixels.secondaryColor } : {}),
    ...(input.catalog?.sourceUrlHash ? { sourceUrlHash: input.catalog.sourceUrlHash } : {}),
    sourceContentHash: input.file.sha256,
  };
}

/**
 * A complete size set already stored as this Oxy file, if there is one.
 *
 * This is the whole of catalogue-image deduplication now. Oxy answers the same
 * file for the same source URL (`file_sources`) and for the same bytes (one live
 * row per owner and SHA-256), so "have we got this image" is "do we have rows for
 * this file" — no URL hashes, no content hashes, no merge script afterwards.
 */
export async function findOxyImageSet(fileId: string): Promise<OxyImageSet | undefined> {
  const rows = await getDb()
    .select({
      id: imageAssets.id,
      size: imageAssets.catalogSize,
      width: imageAssets.width,
      height: imageAssets.height,
      oxyVariant: imageAssets.oxyVariant,
      primaryColor: imageAssets.primaryColor,
      secondaryColor: imageAssets.secondaryColor,
      sourceUrlHash: imageAssets.catalogSourceUrlHash,
      sourceContentHash: imageAssets.catalogSourceContentHash,
      createdAt: imageAssets.createdAt,
    })
    .from(imageAssets)
    .where(
      and(
        eq(imageAssets.oxyFileId, fileId),
        inArray(imageAssets.catalogSize, [...CATALOG_IMAGE_SIZES]),
      ),
    )
    .orderBy(imageAssets.createdAt, imageAssets.id);

  const bySize = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.size && !bySize.has(row.size)) bySize.set(row.size, row);
  }
  if (!CATALOG_IMAGE_SIZES.every((size) => bySize.has(size))) return undefined;

  const imageSizes: CatalogImageSizes = {};
  for (const size of CATALOG_IMAGE_SIZES) {
    const row = bySize.get(size);
    if (!row || row.width === null || row.height === null) continue;
    imageSizes[size] = {
      id: row.id,
      url: `/api/images/${row.id}`,
      width: row.width,
      height: row.height,
      fileId,
      ...(row.oxyVariant === null ? {} : { variant: row.oxyVariant }),
    };
  }
  const primary = bySize.get(PRIMARY_SIZE);
  if (!primary) return undefined;
  return {
    imageId: primary.id,
    imageSizes,
    ...(primary.primaryColor ? { primaryColor: primary.primaryColor } : {}),
    ...(primary.secondaryColor ? { secondaryColor: primary.secondaryColor } : {}),
    ...(primary.sourceUrlHash ? { sourceUrlHash: primary.sourceUrlHash } : {}),
    sourceContentHash: primary.sourceContentHash ?? '',
  };
}

/** Store bytes as a file the SYRA application owns. Public: artwork is shown to everyone. */
export async function uploadAppImage(
  bytes: Buffer,
  mime: string,
  originalName: string,
): Promise<StoredOxyFile> {
  const { file } = await oxyFiles().uploadAppFile(bytes, mime, {
    visibility: 'public',
    originalName,
  });
  return { id: file.id, sha256: file.sha256, size: file.size, mime: file.mime };
}

/**
 * Store bytes as a file in a PERSON's Oxy account — their upload stays theirs.
 *
 * Public, which is what `POST /assets/service/user-media` stores (it takes no
 * visibility) and what these images already are: served to anyone holding the
 * id, and shown on public surfaces once used.
 */
export async function uploadUserImage(
  ownerOxyUserId: string,
  bytes: Buffer,
  mime: string,
  originalName: string,
): Promise<StoredOxyFile> {
  const file = await oxyFiles().uploadUserMedia(ownerOxyUserId, bytes, mime, { originalName });
  return { id: file.id, sha256: file.sha256, size: file.size, mime: file.mime };
}
