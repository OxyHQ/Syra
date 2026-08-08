/**
 * Turning rows into DTOs — the batch reads `serialize.ts` deliberately does not
 * do itself.
 *
 * `serialize.ts` is pure: it takes a row, an {@link ImageVariantLookup} and a
 * context, and returns a DTO. That is what makes it testable without a database
 * and what lets one page share one lookup. But somebody has to BUILD the lookup,
 * count the HLS ladder rows behind `previewAvailable`, and fetch the album cover
 * a track falls back to — and doing that per row is the N+1 the Mongo serializer
 * had (`formatTrackWithCoverArt` issued an `AlbumModel.findById` per track,
 * behind a per-call Map).
 *
 * So this module exists, and everything in it is a BATCH: three queries for a
 * page of any size, and none at all for an empty one.
 *
 * ## Why this is not in `utils/musicHelpers.ts`'s shape
 *
 * That module is gone (Task 11), and this is what it was replaced with rather
 * than ported into. `formatTracksWithCoverArt(tracks: any[]): Promise<any[]>`
 * was typed `any` on both ends, so handing it a drizzle row instead of a
 * Mongoose document type-checked perfectly and returned objects with
 * `undefined` in every field — which four live endpoints did. Every function
 * here names its input and output types.
 */

import { count, inArray } from 'drizzle-orm';
import type {
  Album,
  Artist,
  CatalogImageSizes,
  Playlist,
  PlaylistCollaborator,
  Track,
} from '@syra/shared-types';
import { getDb } from '../postgres';
import { albums, imageAssets, trackHlsRenditions } from '../schema/catalog';
import {
  imageVariantLookup,
  normalizeImageRef,
  toAlbumDto,
  toArtistDto,
  toPlaylistDto,
  toTrackDto,
  type AlbumRow,
  type ImageAssetRow,
  type ImageVariantLookup,
  type PlaylistRow,
  type PublicCatalogEntityRow,
  type PublicTrackRow,
} from './serialize';

/** Every `image_assets` id a track row can reference. */
function trackImageIds(row: PublicTrackRow): (string | null)[] {
  return [
    row.coverArtId,
    row.coverArtSizesSmallId,
    row.coverArtSizesMediumId,
    row.coverArtSizesLargeId,
    row.coverArtSizesXlargeId,
    row.coverArtSizesXxlargeId,
    row.coverArtSizesOriginalId,
  ];
}

/** Every `image_assets` id an album row can reference. */
function albumImageIds(row: AlbumRow): (string | null)[] {
  return [
    row.coverArtId,
    row.coverArtSizesSmallId,
    row.coverArtSizesMediumId,
    row.coverArtSizesLargeId,
    row.coverArtSizesXlargeId,
    row.coverArtSizesXxlargeId,
    row.coverArtSizesOriginalId,
  ];
}

/**
 * Load the `image_assets` rows behind a set of ids, as a lookup.
 *
 * Returns a lookup that answers `undefined` for everything when the id set is
 * empty, WITHOUT issuing a query — `inArray(column, [])` generates `in ()`,
 * which is a syntax error in Postgres rather than an empty result.
 */
export async function loadImageVariants(
  ids: readonly (string | null)[]
): Promise<ImageVariantLookup> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return () => undefined;

  const assets: ImageAssetRow[] = await getDb()
    .select({ id: imageAssets.id, width: imageAssets.width, height: imageAssets.height })
    .from(imageAssets)
    .where(inArray(imageAssets.id, wanted));

  return imageVariantLookup(assets);
}

/**
 * How many `track_hls_renditions` rows each of these tracks has.
 *
 * ONE grouped query rather than a count per track, and required rather than
 * optional: `previewAvailable` is derived from it, and a track whose ladder was
 * not counted would be advertised as previewable when it is not.
 */
async function loadHlsRenditionCounts(trackIds: string[]): Promise<Map<string, number>> {
  if (trackIds.length === 0) return new Map();

  const rows = await getDb()
    .select({ trackId: trackHlsRenditions.trackId, total: count() })
    .from(trackHlsRenditions)
    .where(inArray(trackHlsRenditions.trackId, trackIds))
    .groupBy(trackHlsRenditions.trackId);

  return new Map(rows.map((row) => [row.trackId, row.total]));
}

/** The album cover a track falls back to when it carries none of its own. */
interface AlbumCover {
  coverArt?: string;
  coverArtSizes?: CatalogImageSizes;
}

function albumCoverSizes(row: AlbumRow, lookup: ImageVariantLookup): CatalogImageSizes {
  return {
    small: lookup(row.coverArtSizesSmallId),
    medium: lookup(row.coverArtSizesMediumId),
    large: lookup(row.coverArtSizesLargeId),
    xlarge: lookup(row.coverArtSizesXlargeId),
    xxlarge: lookup(row.coverArtSizesXxlargeId),
    original: lookup(row.coverArtSizesOriginalId),
  };
}

/**
 * Serialize a page of tracks.
 *
 * Three queries regardless of page size: the album rows a track can fall back
 * to for cover art, the `image_assets` behind every referenced variant (track
 * AND album), and the HLS rendition counts.
 *
 * `credits`, `sources` and the rendition LADDER itself are not loaded — they are
 * opt-in on `TrackDtoContext`, and no listing surface renders them. A single
 * track endpoint that does needs its own read.
 */
export async function toTrackDtos(rows: readonly PublicTrackRow[]): Promise<Track[]> {
  if (rows.length === 0) return [];

  const albumIds = [
    ...new Set(rows.map((row) => row.albumId).filter((id): id is string => id !== null)),
  ];

  const albumRows =
    albumIds.length > 0
      ? await getDb().select().from(albums).where(inArray(albums.id, albumIds))
      : [];

  const [lookup, hlsCounts] = await Promise.all([
    loadImageVariants([
      ...rows.flatMap(trackImageIds),
      ...albumRows.flatMap(albumImageIds),
    ]),
    loadHlsRenditionCounts(rows.map((row) => row.id)),
  ]);

  const coverByAlbumId = new Map<string, AlbumCover>();
  for (const album of albumRows) {
    coverByAlbumId.set(album.id, {
      coverArt: normalizeImageRef(album.coverArtId),
      coverArtSizes: albumCoverSizes(album, lookup),
    });
  }

  return rows.map((row) =>
    toTrackDto(row, lookup, {
      hlsRenditionCount: hlsCounts.get(row.id) ?? 0,
      albumCover: row.albumId ? coverByAlbumId.get(row.albumId) : undefined,
    })
  );
}

/**
 * Serialize a page of albums.
 *
 * `genre` is not loaded here: it lives in `album_genres` and only the album
 * DETAIL surface renders it, so a listing that asked for it would pay a join
 * per page for a field nothing shows.
 */
export async function toAlbumDtos(rows: readonly AlbumRow[]): Promise<Album[]> {
  if (rows.length === 0) return [];

  const lookup = await loadImageVariants(rows.flatMap(albumImageIds));
  return rows.map((row) => toAlbumDto(row, lookup));
}

/** Every `image_assets` id a `playlists` row can reference. */
function playlistImageIds(row: PlaylistRow): (string | null)[] {
  return [
    row.coverArtId,
    row.coverArtSizesSmallId,
    row.coverArtSizesMediumId,
    row.coverArtSizesLargeId,
    row.coverArtSizesXlargeId,
    row.coverArtSizesXxlargeId,
    row.coverArtSizesOriginalId,
  ];
}

/**
 * Serialize a page of playlists — ONE `image_assets` query for the whole page.
 *
 * `sources` stays opt-in on `PlaylistDtoContext` for the same reason `strikes`
 * does on the artist one: every discovery shelf renders a name and a cover, and
 * a shelf that loaded them would pay a join per page for a field nothing on it
 * shows.
 *
 * `collaborators` is OPTIONAL rather than absent, and the difference is a
 * behaviour regression the Task 11 review caught. Discovery shelves genuinely
 * do not want it — but `GET /api/playlists` does, because two frontend surfaces
 * (`PlaylistActionsSheet.tsx`, `app/playlist/[id].tsx`) derive "can this user
 * edit" from `playlist.collaborators`, and the Mongo serializer spread the
 * whole document so the list surface had always carried it. Dropping it would
 * have cost editors their rights on that surface the moment anything started
 * writing that table. A caller that wants them passes ONE batch-loaded map for
 * the whole page; a caller that does not passes nothing and pays nothing.
 */
export async function toPlaylistDtos(
  rows: readonly PlaylistRow[],
  collaboratorsByPlaylistId?: ReadonlyMap<string, readonly PlaylistCollaborator[]>
): Promise<Playlist[]> {
  if (rows.length === 0) return [];

  const lookup = await loadImageVariants(rows.flatMap(playlistImageIds));
  return rows.map((row) =>
    toPlaylistDto(row, lookup, { collaborators: collaboratorsByPlaylistId?.get(row.id) })
  );
}

/** Every `image_assets` id a `catalog_entities` row can reference. */
function artistImageIds(row: PublicCatalogEntityRow): (string | null)[] {
  return [
    row.imageId,
    row.imageSizesSmallId,
    row.imageSizesMediumId,
    row.imageSizesLargeId,
    row.imageSizesXlargeId,
    row.imageSizesXxlargeId,
    row.imageSizesOriginalId,
  ];
}

/**
 * Serialize a page of artists — ONE `image_assets` query for the whole page.
 *
 * The third sibling of {@link toTrackDtos} and {@link toAlbumDtos}, added when
 * the recommendation surfaces needed it: they were the only artist-returning
 * endpoints with no batch serializer, and what filled the gap was
 * `formatArtistsWithImage(artists: any[])`, which accepted the drizzle rows and
 * returned `{"id":"", …}`. `strikes` and `sources` stay opt-in on
 * `ArtistDtoContext`: no listing surface renders either, and a shelf that
 * loaded them would pay two joins per page for fields nothing shows.
 */
export async function toArtistDtos(
  rows: readonly PublicCatalogEntityRow[]
): Promise<Artist[]> {
  if (rows.length === 0) return [];

  const lookup = await loadImageVariants(rows.flatMap(artistImageIds));
  return rows.map((row) => toArtistDto(row, lookup));
}
