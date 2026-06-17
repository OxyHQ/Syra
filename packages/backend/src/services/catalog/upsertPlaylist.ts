import type {
  CatalogSource,
  ExternalPlaylist,
  SourceProvenance,
} from '@syra/shared-types';
import { PlaylistVisibility } from '@syra/shared-types';
import { PlaylistModel } from '../../models/Playlist';
import type { IPlaylist } from '../../models/Playlist';
import { PlaylistTrackModel } from '../../models/PlaylistTrack';
import { TrackModel } from '../../models/Track';
import { assignMissingColors, replaceColors } from './entityColors';
import { usableImages } from './externalImages';
import { mirrorCatalogImage } from './catalogImageAssets';

const EXTERNAL_OWNER_ID = 'system:audius';
const EXTERNAL_OWNER_NAME = 'Audius';

export interface UpsertPlaylistResult {
  playlist: IPlaylist | null;
  created: boolean;
}

function contributedFields(external: ExternalPlaylist): string[] {
  const fields: string[] = ['name'];
  if (external.description) fields.push('description');
  if (external.images?.length) fields.push('coverArt');
  if (external.popularity) fields.push('popularity');
  if (external.trackExternalIds?.length) fields.push('tracks');
  return fields;
}

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

async function findExisting(source: CatalogSource, externalId: string): Promise<IPlaylist | null> {
  if (source === 'audius') {
    const byAudiusId = await PlaylistModel.findOne({ 'externalIds.audiusId': externalId });
    if (byAudiusId) return byAudiusId;
  }
  return PlaylistModel.findOne({
    sources: { $elemMatch: { provider: source, externalId } },
  });
}

async function resolveOrderedTrackIds(
  source: CatalogSource,
  trackExternalIds: string[] | undefined,
): Promise<string[]> {
  if (!trackExternalIds?.length) return [];

  const uniqueExternalIds = [...new Set(trackExternalIds)];
  const query =
    source === 'audius'
      ? { 'externalIds.audiusId': { $in: uniqueExternalIds } }
      : { sources: { $elemMatch: { provider: source, externalId: { $in: uniqueExternalIds } } } };

  const tracks = await TrackModel.find(query).lean();
  const byExternalId = new Map<string, string>();
  for (const track of tracks) {
    const externalId = source === 'audius'
      ? track.externalIds?.audiusId
      : track.sources?.find((entry) => entry.provider === source)?.externalId;
    if (externalId) byExternalId.set(externalId, track._id.toString());
  }

  const orderedTrackIds: string[] = [];
  const seenTrackIds = new Set<string>();
  for (const externalId of trackExternalIds) {
    const trackId = byExternalId.get(externalId);
    if (!trackId || seenTrackIds.has(trackId)) continue;
    seenTrackIds.add(trackId);
    orderedTrackIds.push(trackId);
  }

  return orderedTrackIds;
}

async function replacePlaylistTracks(
  playlistId: IPlaylist['_id'],
  trackIds: string[],
): Promise<{ totalTracks: number; totalDuration: number }> {
  await PlaylistTrackModel.deleteMany({ playlistId });

  if (trackIds.length > 0) {
    const now = new Date().toISOString();
    await PlaylistTrackModel.insertMany(
      trackIds.map((trackId, order) => ({
        playlistId,
        trackId,
        addedAt: now,
        addedBy: EXTERNAL_OWNER_ID,
        order,
      })),
      { ordered: true },
    );
  }

  const tracks = await TrackModel.find({ _id: { $in: trackIds }, isAvailable: true }).lean();
  const totalDuration = tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0);

  return { totalTracks: tracks.length, totalDuration };
}

export async function upsertPlaylist(
  external: ExternalPlaylist,
  source: CatalogSource,
): Promise<UpsertPlaylistResult> {
  const provenance = buildProvenance(source, external.externalId, contributedFields(external));
  const images = usableImages(external.images);

  const orderedTrackIds = await resolveOrderedTrackIds(source, external.trackExternalIds);
  if (orderedTrackIds.length === 0) {
    return { playlist: null, created: false };
  }

  const existing = await findExisting(source, external.externalId);
  const mirroredCover = await mirrorCatalogImage(images, {
    provider: source,
    entityType: 'playlist',
    externalId: external.externalId,
    existingImageId: existing?.coverArt,
    existingImageSizes: existing?.coverArtSizes,
  });
  if (!existing && !mirroredCover) {
    return { playlist: null, created: false };
  }
  const coverArtChanged = Boolean(mirroredCover && mirroredCover.imageId !== existing?.coverArt);

  if (!existing) {
    const created = await PlaylistModel.create({
      name: external.name,
      description: external.description,
      ownerOxyUserId: EXTERNAL_OWNER_ID,
      ownerUsername: EXTERNAL_OWNER_NAME,
      coverArt: mirroredCover?.imageId,
      coverArtSizes: mirroredCover?.imageSizes,
      visibility: PlaylistVisibility.PUBLIC,
      isPublic: true,
      trackCount: 0,
      totalDuration: 0,
      followers: 0,
      source,
      externalIds: source === 'audius' ? { audiusId: external.externalId } : undefined,
      sources: [provenance],
      primaryColor: mirroredCover?.primaryColor,
      secondaryColor: mirroredCover?.secondaryColor,
    });

    const totals = await replacePlaylistTracks(created._id, orderedTrackIds);
    created.trackCount = totals.totalTracks;
    created.totalDuration = totals.totalDuration;
    const playlist = await created.save();

    return { playlist, created: true };
  }

  existing.sources = [...(existing.sources ?? []), provenance];
  if (external.name) existing.name = external.name;
  if (external.description) existing.description = external.description;
  if (mirroredCover) {
    existing.coverArt = mirroredCover.imageId;
    existing.coverArtSizes = mirroredCover.imageSizes;
  }
  if (coverArtChanged) {
    replaceColors(existing, mirroredCover);
  } else {
    assignMissingColors(existing, mirroredCover);
  }
  if (source === 'audius' && external.externalId && !existing.externalIds?.audiusId) {
    existing.externalIds = { ...(existing.externalIds ?? {}), audiusId: external.externalId };
  }
  if (!existing.source) existing.source = source;
  existing.visibility = PlaylistVisibility.PUBLIC;
  existing.isPublic = true;

  const totals = await replacePlaylistTracks(existing._id, orderedTrackIds);
  existing.trackCount = totals.totalTracks;
  existing.totalDuration = totals.totalDuration;

  const playlist = await existing.save();
  return { playlist, created: false };
}
