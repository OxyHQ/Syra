import type { ExternalArtist, CatalogSource, SourceProvenance } from '@syra/shared-types';
import { ArtistModel } from '../../models/CatalogEntity';
import type { IArtist } from '../../models/CatalogEntity';
import { assignMissingColors, replaceColors } from './entityColors';
import { usableImages } from './externalImages';
import { mirrorCatalogImage } from './catalogImageAssets';

/**
 * Build a SourceProvenance entry recording this import.
 * `fields` lists which top-level artist fields were contributed by the provider.
 */
function buildProvenance(
  source: CatalogSource,
  externalId: string,
  fields: string[],
): SourceProvenance {
  return {
    provider: source,
    externalId,
    importedAt: new Date().toISOString(),
    fields,
  };
}

/**
 * Find an existing artist document that matches this external entity.
 *
 * Dedup strategy:
 *  - audius: match by `externalIds.audiusId`
 *  - others: match by a `sources[]` entry with the same provider + externalId
 */
async function findExisting(
  source: CatalogSource,
  externalId: string,
): Promise<IArtist | null> {
  if (source === 'audius') {
    return ArtistModel.findOne({ 'externalIds.audiusId': externalId });
  }
  return ArtistModel.findOne({
    sources: { $elemMatch: { provider: source, externalId } },
  });
}

/**
 * Upsert an external artist into the catalog.
 *
 * - New artist → insert with source, claimable=true, externalIds, first provenance.
 * - Existing match → merge non-empty fields; if ownerOxyUserId is set, skip all
 *   owned-field updates (bio, image, name) but always append provenance.
 *
 * @returns The saved artist document and whether it was newly created.
 */
export async function upsertArtist(
  external: ExternalArtist,
  source: CatalogSource,
): Promise<{ artist: IArtist | null; created: boolean }> {
  const existing = await findExisting(source, external.externalId);
  const images = usableImages(external.images);
  const mirroredImage = !existing?.ownerOxyUserId
    ? await mirrorCatalogImage(images, {
      provider: source,
      entityType: 'artist',
      externalId: external.externalId,
      existingImageId: existing?.image,
      existingImageSizes: existing?.imageSizes,
    })
    : undefined;

  if (!mirroredImage && !existing?.image) {
    return { artist: null, created: false };
  }

  const imageChanged = Boolean(mirroredImage && mirroredImage.imageId !== existing?.image);

  const provenance = buildProvenance(
    source,
    external.externalId,
    [
      'name',
      ...(images.length ? ['images'] : []),
    ],
  );

  if (!existing) {
    if (!mirroredImage) {
      return { artist: null, created: false };
    }

    const artist = await ArtistModel.create({
      name: external.name,
      source,
      claimable: true,
      externalIds: source === 'audius' ? { audiusId: external.externalId } : undefined,
      image: mirroredImage?.imageId,
      imageSizes: mirroredImage?.imageSizes,
      images: [],
      primaryColor: mirroredImage?.primaryColor,
      secondaryColor: mirroredImage?.secondaryColor,
      sources: [provenance],
      stats: { followers: 0, albums: 0, tracks: 0, totalPlays: 0, monthlyListeners: 0 },
    });
    return { artist, created: true };
  }

  // Append a new provenance entry every import (dedup by timestamp is intentional —
  // callers that want idempotent provenance should check before calling).
  existing.sources = [...(existing.sources ?? []), provenance];

  // If this artist is claimed by a real user, protect all owned fields.
  if (!existing.ownerOxyUserId) {
    if (external.name) existing.name = external.name;
    existing.images = [];
    if (mirroredImage) {
      existing.image = mirroredImage.imageId;
      existing.imageSizes = mirroredImage.imageSizes;
    }
    if (imageChanged) {
      replaceColors(existing, mirroredImage);
    } else {
      assignMissingColors(existing, mirroredImage);
    }
    if (source === 'audius' && external.externalId) {
      existing.externalIds = {
        ...(existing.externalIds ?? {}),
        audiusId: external.externalId,
      };
    }
  }

  const artist = await existing.save();
  return { artist, created: false };
}
