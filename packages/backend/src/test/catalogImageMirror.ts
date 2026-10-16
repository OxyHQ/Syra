/**
 * The catalog image-mirror test double, and the reason it is its own module.
 *
 * `mirrorCatalogImage` is the backend's single chokepoint for an external image:
 * it has Oxy import the URL and builds the size rows. No test wants a network
 * call, so every suite that touches enrichment replaces it (or installs
 * `test/fakeOxyFiles.ts` to exercise the real one).
 *
 * It is its own module, installed explicitly, rather than a side effect of a
 * database hook: that coupling is invisible, and a suite that dropped the hook
 * would silently lose its image mock and start making real HTTP requests.
 *
 * ## It writes REAL `image_assets` rows, and it has to
 *
 * The variant ids are written into `catalog_entities.image_id` and the six
 * `image_sizes_*_id` columns, every one a foreign key to `image_assets` — so a
 * minted id is a constraint violation, not a harmless fake. The double inserts
 * the rows it claims to have created, which is also what makes the variant
 * lookup in `db/catalog/hydrate.ts` resolve them.
 */

import { uuidv7 } from '@oxy.so/db';
import { setCatalogImageMirrorImplementationForTests } from '../services/catalog/catalogImageAssets';
import { getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';

/** Widths the real mirror produces, so a consumer sees the shape it expects. */
const VARIANT_WIDTHS = {
  small: 160,
  medium: 320,
  large: 640,
  xlarge: 960,
  xxlarge: 1280,
  original: 1000,
} as const;

/**
 * Insert a real asset row and return the variant DTO pointing at it — stored the
 * way the real mirror stores catalogue artwork now, as an Oxy file (ADR 0041).
 */
async function makeVariant(width: number, id = uuidv7()) {
  const fileId = `test-mirror-file-${id}`;
  await getDb()
    .insert(imageAssets)
    .values({
      id,
      oxyFileId: fileId,
      filename: `${id}.webp`,
      contentType: 'image/webp',
      byteSize: 1024,
      width,
      height: width,
      ownerType: 'artist',
    })
    .onConflictDoNothing();

  return { id, url: `/api/images/${id}`, width, height: width, fileId };
}

/**
 * Replace `mirrorCatalogImage` with a double that stores real rows.
 *
 * Call it from a suite's `beforeEach` — AFTER the Postgres connection is open,
 * because it writes. `resetCatalogImageMirror()` puts the real implementation
 * back.
 */
export function installCatalogImageMirrorMockForTests(): void {
  setCatalogImageMirrorImplementationForTests(async (images, context) => {
    if (!images?.length) return undefined;

    // An unchanged source returns the caller's existing image untouched, which
    // is the branch `enrichCatalogEntity` relies on to be idempotent.
    const largeId = context.existingImageId ?? uuidv7();

    const [small, medium, large, xlarge, xxlarge, original] = await Promise.all([
      makeVariant(VARIANT_WIDTHS.small),
      makeVariant(VARIANT_WIDTHS.medium),
      makeVariant(VARIANT_WIDTHS.large, largeId),
      makeVariant(VARIANT_WIDTHS.xlarge),
      makeVariant(VARIANT_WIDTHS.xxlarge),
      makeVariant(VARIANT_WIDTHS.original),
    ]);

    return {
      imageId: largeId,
      imageSizes: context.existingImageSizes ?? {
        small,
        medium,
        large,
        xlarge,
        xxlarge,
        original,
      },
      primaryColor: '#336699',
      secondaryColor: '#224466',
      sourceUrlHash: `test-url-${context.provider}-${context.entityType}-${context.externalId}`,
      sourceContentHash: `test-content-${context.provider}-${context.entityType}-${context.externalId}`,
    };
  });
}

/** Restore the real mirror. */
export function resetCatalogImageMirror(): void {
  setCatalogImageMirrorImplementationForTests();
}
