import type { ExternalArtist, CatalogSource, SourceProvenance, TrackImage } from '@syra/shared-types';
import { ArtistModel } from '../../models/Artist';
import type { IArtist } from '../../models/Artist';
import { assignMissingColors, colorsFromImages } from './entityColors';

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
 * Merge external images into an existing image array, deduplicating by URL.
 */
function mergeImages(
  existing: TrackImage[] | undefined,
  incoming: TrackImage[] | undefined,
): TrackImage[] {
  const base = existing ?? [];
  if (!incoming?.length) return base;
  const seen = new Set(base.map((img) => img.url));
  const additions = incoming.filter((img) => !seen.has(img.url));
  return [...base, ...additions];
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
): Promise<{ artist: IArtist; created: boolean }> {
  const existing = await findExisting(source, external.externalId);
  const needsColors = !existing || (!existing.ownerOxyUserId && (!existing.primaryColor || !existing.secondaryColor));
  const colors = needsColors ? await colorsFromImages(external.images) : undefined;

  const provenance = buildProvenance(
    source,
    external.externalId,
    [
      'name',
      ...(external.images?.length ? ['images'] : []),
    ],
  );

  if (!existing) {
    const artist = await ArtistModel.create({
      name: external.name,
      source,
      claimable: true,
      externalIds: source === 'audius' ? { audiusId: external.externalId } : undefined,
      images: external.images ?? [],
      primaryColor: colors?.primaryColor,
      secondaryColor: colors?.secondaryColor,
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
    existing.images = mergeImages(existing.images, external.images);
    assignMissingColors(existing, colors);
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
