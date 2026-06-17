import type {
  ExternalAlbum,
  CatalogSource,
  SourceProvenance,
} from '@syra/shared-types';
import { AlbumModel } from '../../models/Album';
import type { IAlbum } from '../../models/Album';
import { TrackModel } from '../../models/Track';
import type { ITrack } from '../../models/Track';
import { playCountToPopularity } from './popularity';
import { assignMissingColors, colorsFromImages } from './entityColors';
import { firstUsableImageUrl, usableImages } from './externalImages';

/** Minimal artist context needed to attach an album to its primary artist. */
export interface AlbumArtistRef {
  artistId: string;
  artistName: string;
}

/** Result of an upsert. `album` is null only when the album was skipped. */
export interface UpsertAlbumResult {
  album: IAlbum | null;
  created: boolean;
}

/**
 * Determine which fields the external payload is contributing (non-empty values
 * that will actually be written). Used to populate SourceProvenance.fields.
 */
function contributedFields(external: ExternalAlbum): string[] {
  const fields: string[] = ['title'];
  if (external.releaseDate) fields.push('releaseDate');
  if (external.genre) fields.push('genre');
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

/** Find an existing album by provenance — audiusId, or provider+externalId in sources[]. */
async function findExisting(source: CatalogSource, externalId: string): Promise<IAlbum | null> {
  if (source === 'audius') {
    const byAudiusId = await AlbumModel.findOne({ 'externalIds.audiusId': externalId });
    if (byAudiusId) return byAudiusId;
  }
  return AlbumModel.findOne({
    sources: { $elemMatch: { provider: source, externalId } },
  });
}

async function resolveMemberTracks(
  source: CatalogSource,
  trackExternalIds: string[] | undefined,
): Promise<IAlbumMemberTrack[]> {
  if (!trackExternalIds?.length) {
    return [];
  }

  const tracks: IAlbumMemberTrack[] = [];

  for (const externalId of trackExternalIds) {
    const query =
      source === 'audius'
        ? { 'externalIds.audiusId': externalId }
        : { sources: { $elemMatch: { provider: source, externalId } } };

    const track = await TrackModel.findOne(query);
    if (!track) continue;
    tracks.push(track);
  }

  return tracks;
}

type IAlbumMemberTrack = ITrack;

/**
 * Link the album's resolved member tracks and compute rolled-up totals.
 */
async function linkMemberTracks(
  albumId: string,
  albumName: string,
  tracks: IAlbumMemberTrack[],
): Promise<{ totalTracks: number; totalDuration: number }> {
  let totalDuration = 0;

  for (const track of tracks) {
    track.albumId = albumId;
    if (!track.albumName) track.albumName = albumName;
    await track.save();
    totalDuration += track.duration ?? 0;
  }

  return { totalTracks: tracks.length, totalDuration };
}

/**
 * Upsert an external album into the catalog.
 *
 * Dedup by provenance: same provider + externalId (audiusId for Audius). New
 * albums are inserted; existing matches merge non-empty fields without
 * clobbering and always append a provenance entry.
 *
 * Albums without usable cover art are skipped (`Album.coverArt` is required) —
 * returned as `{ album: null, created: false }` so callers can count skips.
 *
 * Member tracks already in the catalog are linked (their `albumId` is set) and
 * the album's `totalTracks` / `totalDuration` are rolled up from them.
 */
export async function upsertAlbum(
  external: ExternalAlbum,
  artist: AlbumArtistRef,
  source: CatalogSource,
): Promise<UpsertAlbumResult> {
  const images = usableImages(external.images);
  const coverArt = firstUsableImageUrl(images);
  if (!coverArt) {
    // Album.coverArt is required; without it we cannot persist a valid album.
    return { album: null, created: false };
  }

  const provenance = buildProvenance(source, external.externalId, contributedFields(external));
  const playCount = external.popularity?.playCount;
  const genres = external.genre ? [external.genre] : [];
  const memberTracks = await resolveMemberTracks(source, external.trackExternalIds);
  if (memberTracks.length === 0) {
    return { album: null, created: false };
  }

  const existing = await findExisting(source, external.externalId);
  const colors = (!existing || !existing.primaryColor || !existing.secondaryColor)
    ? await colorsFromImages(images)
    : undefined;

  if (!existing) {
    const created = await AlbumModel.create({
      title: external.name,
      artistId: artist.artistId,
      artistName: artist.artistName,
      releaseDate: external.releaseDate ?? new Date().toISOString(),
      coverArt,
      genre: genres,
      type: 'album',
      source,
      externalIds: source === 'audius' ? { audiusId: external.externalId } : undefined,
      sources: [provenance],
      primaryColor: colors?.primaryColor,
      secondaryColor: colors?.secondaryColor,
      ...(playCount !== undefined
        ? { playCount, popularity: playCountToPopularity(playCount) }
        : {}),
      ...(external.popularity?.favoriteCount !== undefined
        ? { favoriteCount: external.popularity.favoriteCount }
        : {}),
      ...(external.popularity?.repostCount !== undefined
        ? { repostCount: external.popularity.repostCount }
        : {}),
    });

    const totals = await linkMemberTracks(
      created._id.toString(),
      created.title,
      memberTracks,
    );
    created.totalTracks = totals.totalTracks;
    created.totalDuration = totals.totalDuration;
    const album = await created.save();

    return { album, created: true };
  }

  // --- Update: merge without clobbering ---
  existing.sources = [...(existing.sources ?? []), provenance];
  if (external.name) existing.title = external.name;
  if (external.releaseDate) existing.releaseDate = external.releaseDate;
  if (coverArt && !existing.coverArt) existing.coverArt = coverArt;
  assignMissingColors(existing, colors);
  if (external.genre && !existing.genre?.includes(external.genre)) {
    existing.genre = [...(existing.genre ?? []), external.genre];
  }
  if (source === 'audius' && external.externalId && !existing.externalIds?.audiusId) {
    existing.externalIds = { ...(existing.externalIds ?? {}), audiusId: external.externalId };
  }
  if (!existing.source) existing.source = source;
  // Popularity counts are monotonic — only refresh upward.
  if (playCount !== undefined && playCount > (existing.playCount ?? 0)) {
    existing.playCount = playCount;
    existing.popularity = playCountToPopularity(playCount);
  }
  if (
    external.popularity?.favoriteCount !== undefined &&
    external.popularity.favoriteCount > (existing.favoriteCount ?? 0)
  ) {
    existing.favoriteCount = external.popularity.favoriteCount;
  }
  if (
    external.popularity?.repostCount !== undefined &&
    external.popularity.repostCount > (existing.repostCount ?? 0)
  ) {
    existing.repostCount = external.popularity.repostCount;
  }

  const totals = await linkMemberTracks(
    existing._id.toString(),
    existing.title,
    memberTracks,
  );
  existing.totalTracks = totals.totalTracks;
  existing.totalDuration = totals.totalDuration;

  const album = await existing.save();
  return { album, created: false };
}
