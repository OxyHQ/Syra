/**
 * Catalog serialization, on drizzle — the replacement for `utils/musicHelpers.ts`.
 *
 * ## `toApiFormat` is not ported, and this is the reason
 *
 * The Mongo serializer spread the whole document (`{ ...docObj }`) and then
 * DELETED the fields that must not ship. Two things made that fragile, and both
 * were load-bearing in production:
 *
 *  - `select: false` is a QUERY PROJECTION, and `aggregate()` ignores it
 *    entirely. Every container read in `utils/playableContainers.ts` is an
 *    aggregation, so `CatalogEntity.imageSuggestions` — "protected" that way —
 *    was returned in full by `GET /api/artists/:id`.
 *  - A field's absence from the zod schema removed nothing, because the
 *    formatter was untyped and spread first.
 *
 * So the guard was one hand-maintained `delete` list, and the single point of
 * failure was "no track read is ever an aggregation" — a property nobody can
 * hold in their head, which had already lapsed once.
 *
 * Every DTO below instead NAMES each field it returns. A column added to the
 * schema tomorrow is absent from the wire until somebody writes it in here, and
 * the reads that feed these functions select
 * `publicColumns(table, PROTECTED_COLUMNS_BY_TABLE)`, so a protected column is
 * not merely deleted late — it has no property on the row type at all, and
 * naming one fails `tsc`.
 *
 * ## `null` is not `undefined`, and the DTOs care
 *
 * Mongo simply had no key for an absent value; Postgres returns `null`. Every
 * optional field in `@syra/shared-types` is `.optional()` (undefined), NOT
 * `.nullable()`, so handing a `null` straight through would fail the SDK's own
 * parse. {@link optional} performs that conversion once, and {@link compact}
 * drops a nested object entirely when every part of it is absent — which is what
 * a missing Mongo subdocument looked like.
 */

import type {
  Album,
  Artist,
  ArtistStats,
  AudioSource,
  CatalogImageSizes,
  CatalogImageVariant,
  HlsRendition,
  ImageLicence,
  Playlist,
  PlaylistCollaborator,
  SourceProvenance,
  Track,
  TrackCredit,
} from '@syra/shared-types';
import { isLiveEntityId } from '@oxyhq/db';
import type { albums, catalogEntities, imageAssets, tracks } from '../schema/catalog';
import type { playlists } from '../schema/library';
import { PROTECTED_COLUMNS_BY_TABLE } from '../schema/protectedColumns';
import { isPreviewEligibleTrack } from './visibility';

// ── Row shapes ────────────────────────────────────────────────────────────
//
// Derived from the drizzle table types MINUS this schema's protected columns,
// so the registry stays the single source of truth: adding a column to
// `PROTECTED_COLUMNS_BY_TABLE` removes it from these types, and any serializer
// still naming it stops compiling.

/** A `tracks` row as `publicColumns()` returns it. */
export type PublicTrackRow = Omit<
  typeof tracks.$inferSelect,
  (typeof PROTECTED_COLUMNS_BY_TABLE)['tracks'][number]
>;

/** A `catalog_entities` row as `publicColumns()` returns it. */
export type PublicCatalogEntityRow = Omit<
  typeof catalogEntities.$inferSelect,
  (typeof PROTECTED_COLUMNS_BY_TABLE)['catalog_entities'][number]
>;

/** `albums` and `playlists` protect no columns, so the whole row is public. */
export type AlbumRow = typeof albums.$inferSelect;
export type PlaylistRow = typeof playlists.$inferSelect;

/** The `image_assets` columns a rendered variant needs. */
export type ImageAssetRow = Pick<typeof imageAssets.$inferSelect, 'id' | 'width' | 'height'>;

/**
 * Resolves an `image_assets` id to its rendered variant, or `undefined` when the
 * asset is unknown or carries no dimensions.
 *
 * A function rather than a `Map` so a caller that has already joined the assets
 * can supply them without building one, and so a caller serializing a single row
 * can pass a lookup that closes over one batch query instead of issuing seven.
 */
export type ImageVariantLookup = (id: string | null) => CatalogImageVariant | undefined;

// ── Small conversions ─────────────────────────────────────────────────────

/** Postgres `null` to the `undefined` every `@syra/shared-types` DTO expects. */
function optional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/**
 * Drop every `undefined`-valued key, and return `undefined` when nothing is
 * left — the shape a missing Mongo subdocument had.
 */
function compact<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

/** A `timestamptz` column as the ISO string every DTO declares. */
function isoOptional(value: Date | null): string | undefined {
  return value ? value.toISOString() : undefined;
}

/** A `NOT NULL timestamptz` column. */
function iso(value: Date): string {
  return value.toISOString();
}

// ── Images ────────────────────────────────────────────────────────────────

/**
 * Resolve a stored image reference to its `/api/images/:id` path.
 *
 * Accepts an already-normalised path unchanged, and an entity id in EITHER
 * shape this schema stores — a 24-char ObjectId hex carried over from Mongo, or
 * a uuid v7 minted since. The Mongo helper tested for the ObjectId shape only;
 * keeping that here would silently return `undefined` for every image created
 * after the cutover, which is the failure `isLiveEntityId` exists to prevent.
 */
export function normalizeImageRef(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.startsWith('/api/images/')) return value;
  return isLiveEntityId(value) ? `/api/images/${value}` : undefined;
}

/**
 * Build the variant lookup for a page of rows from the `image_assets` rows the
 * caller loaded.
 *
 * `url` is not stored: it is always literally `/api/images/${id}`, and `width`/
 * `height` live on the asset row itself — which is why `schema/catalog.ts` keeps
 * one FK column per variant rather than four denormalised copies.
 */
export function imageVariantLookup(assets: readonly ImageAssetRow[]): ImageVariantLookup {
  const byId = new Map<string, CatalogImageVariant>();
  for (const asset of assets) {
    const url = normalizeImageRef(asset.id);
    // A variant is only renderable with real dimensions; the Mongo normalizer
    // skipped entries missing `id`/`url` for the same reason.
    if (!url || asset.width === null || asset.height === null) continue;
    byId.set(asset.id, { id: asset.id, url, width: asset.width, height: asset.height });
  }
  return (id) => (id === null ? undefined : byId.get(id));
}

/** The seven per-variant FK columns, in the order the DTO declares them. */
interface ImageSizeIds {
  readonly small: string | null;
  readonly medium: string | null;
  readonly large: string | null;
  readonly xlarge: string | null;
  readonly xxlarge: string | null;
  readonly original: string | null;
}

function toImageSizes(
  ids: ImageSizeIds,
  lookup: ImageVariantLookup
): CatalogImageSizes | undefined {
  return compact({
    small: lookup(ids.small),
    medium: lookup(ids.medium),
    large: lookup(ids.large),
    xlarge: lookup(ids.xlarge),
    xxlarge: lookup(ids.xxlarge),
    original: lookup(ids.original),
  });
}

/** The four flattened `ImageLicence` columns, reassembled. */
function toImageLicence(
  licence: string | null,
  licenceUrl: string | null,
  attribution: string | null,
  sourceUrl: string | null
): ImageLicence | undefined {
  // `licence`, `attribution` and `sourceUrl` are all REQUIRED by
  // `imageLicenceSchema` — only `licenceUrl` is optional, because `PD` has no
  // canonical deed URL. The four columns are individually nullable, so a row
  // can hold a partial licence; emitting one would produce a DTO that fails the
  // SDK's own parse, which is precisely the class of bug an explicit allowlist
  // exists to make visible. A partial licence is therefore no licence.
  if (!licence || !attribution || !sourceUrl) return undefined;
  return {
    licence,
    attribution,
    sourceUrl,
    ...(licenceUrl === null ? {} : { licenceUrl }),
  };
}

// ── Track ─────────────────────────────────────────────────────────────────

/**
 * Everything a track DTO needs beyond its own row: the child-table collections
 * a caller chose to load, and the album fallback.
 */
export interface TrackDtoContext {
  /**
   * Rows in `track_hls_renditions` for this track.
   *
   * The COUNT is required even when the ladder itself is not serialized,
   * because `previewAvailable` is derived from it — a track with no ladder and
   * no retained original has no clip to serve, and the SDK must not offer a
   * preview that would 404.
   */
  readonly hlsRenditionCount: number;
  readonly hlsRenditions?: readonly HlsRendition[];
  readonly credits?: readonly TrackCredit[];
  readonly sources?: readonly SourceProvenance[];
  /**
   * The album's cover, used only when the track carries none of its own —
   * the `formatTrackWithCoverArt` fallback, now supplied by the caller's join
   * instead of a per-track `AlbumModel.findById` behind a Map cache.
   */
  readonly albumCover?: {
    readonly coverArt?: string;
    readonly coverArtSizes?: CatalogImageSizes;
  };
}

export function toTrackDto(
  row: PublicTrackRow,
  lookup: ImageVariantLookup,
  context: TrackDtoContext
): Track {
  const ownCoverArt = normalizeImageRef(row.coverArtId);
  const ownCoverArtSizes = toImageSizes(
    {
      small: row.coverArtSizesSmallId,
      medium: row.coverArtSizesMediumId,
      large: row.coverArtSizesLargeId,
      xlarge: row.coverArtSizesXlargeId,
      xxlarge: row.coverArtSizesXxlargeId,
      original: row.coverArtSizesOriginalId,
    },
    lookup
  );

  const audioSource: AudioSource | undefined =
    row.audioSourceUrl && row.audioSourceFormat
      ? {
          url: row.audioSourceUrl,
          format: row.audioSourceFormat,
          ...(row.audioSourceBitrate === null ? {} : { bitrate: row.audioSourceBitrate }),
          ...(row.audioSourceDuration === null ? {} : { duration: row.audioSourceDuration }),
        }
      : undefined;

  return {
    id: row.id,
    title: row.title,
    artistId: row.artistId,
    artistName: row.artistName,
    albumId: optional(row.albumId),
    albumName: optional(row.albumName),
    duration: row.duration,
    trackNumber: optional(row.trackNumber),
    discNumber: optional(row.discNumber),

    // Edition facts captured from the file's tags.
    totalTracks: optional(row.totalTracks),
    totalDiscs: optional(row.totalDiscs),
    originalReleaseDate: optional(row.originalReleaseDate),
    catalogNumber: optional(row.catalogNumber),
    label: optional(row.label),
    media: optional(row.media),
    releaseCountry: optional(row.releaseCountry),
    replayGain: compact({
      trackDb: optional(row.replayGainTrackDb),
      albumDb: optional(row.replayGainAlbumDb),
      trackPeak: optional(row.replayGainTrackPeak),
    }),
    comment: optional(row.comment),
    credits: context.credits ? [...context.credits] : undefined,

    audioSource,
    coverArt: ownCoverArt ?? context.albumCover?.coverArt,
    coverArtSizes: ownCoverArtSizes ?? context.albumCover?.coverArtSizes,

    metadata: compact({
      genre: optional(row.metadataGenre),
      bpm: optional(row.metadataBpm),
      key: optional(row.metadataKey),
      explicit: optional(row.metadataExplicit),
      language: optional(row.metadataLanguage),
      copyright: optional(row.metadataCopyright),
      publisher: optional(row.metadataPublisher),
    }),
    genre: optional(row.genre),
    mood: optional(row.mood),
    tags: row.tags,
    releaseDate: isoOptional(row.releaseDate),
    isExplicit: row.isExplicit,
    popularity: row.popularity,
    playCount: row.playCount,
    favoriteCount: row.favoriteCount,
    repostCount: row.repostCount,
    primaryColor: optional(row.primaryColor),
    secondaryColor: optional(row.secondaryColor),

    isAvailable: row.isAvailable,
    copyrightRemoved: row.copyrightRemoved,
    removedAt: isoOptional(row.removedAt),
    removedReason: optional(row.removedReason),
    removedBy: optional(row.removedBy),
    copyrightReportId: optional(row.copyrightReportId),

    source: row.source,
    status: row.status,
    externalIds: compact({ isrc: optional(row.externalIsrc) }),
    sources: context.sources ? [...context.sources] : undefined,
    hls: context.hlsRenditions ? [...context.hlsRenditions] : undefined,
    loudnessLufs: optional(row.loudnessLufs),
    hlsMasterKey: optional(row.hlsMasterKey),

    /**
     * A public 30s preview can be served iff the track is playable AND a clip
     * is regenerable. Derived here and never persisted — there is no stored
     * `previewAvailable` column and no raw preview URL on the wire.
     */
    previewAvailable: isPreviewEligible(row, context.hlsRenditionCount),

    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** Bridge to `visibility.ts`'s predicate over the columns this row carries. */
function isPreviewEligible(row: PublicTrackRow, hlsRenditionCount: number): boolean {
  return isPreviewEligibleTrack({
    isAvailable: row.isAvailable,
    copyrightRemoved: row.copyrightRemoved,
    status: row.status,
    hlsMasterKey: row.hlsMasterKey,
    hlsRenditionCount,
    audioSourceUrl: row.audioSourceUrl,
  });
}

// ── Album ─────────────────────────────────────────────────────────────────

export interface AlbumDtoContext {
  readonly genres?: readonly string[];
  readonly sources?: readonly SourceProvenance[];
}

export function toAlbumDto(
  row: AlbumRow,
  lookup: ImageVariantLookup,
  context: AlbumDtoContext = {}
): Album {
  // `coverArt` is REQUIRED on the DTO and the column is `NOT NULL`, so the only
  // way `normalizeImageRef` returns undefined here is a malformed stored id.
  // Falling back to the raw path keeps the contract satisfied rather than
  // emitting a DTO that fails its own parse.
  const coverArt = normalizeImageRef(row.coverArtId) ?? `/api/images/${row.coverArtId}`;

  return {
    id: row.id,
    title: row.title,
    artistId: row.artistId,
    artistName: row.artistName,
    releaseDate: row.releaseDate,
    coverArt,
    coverArtSizes: toImageSizes(
      {
        small: row.coverArtSizesSmallId,
        medium: row.coverArtSizesMediumId,
        large: row.coverArtSizesLargeId,
        xlarge: row.coverArtSizesXlargeId,
        xxlarge: row.coverArtSizesXxlargeId,
        original: row.coverArtSizesOriginalId,
      },
      lookup
    ),
    coverArtLicence: toImageLicence(
      row.coverArtLicenceLicence,
      row.coverArtLicenceLicenceUrl,
      row.coverArtLicenceAttribution,
      row.coverArtLicenceSourceUrl
    ),
    genre: context.genres ? [...context.genres] : undefined,
    totalTracks: row.totalTracks,
    totalDuration: row.totalDuration,
    type: row.type,
    label: optional(row.label),
    copyright: optional(row.copyright),
    upc: optional(row.upc),
    catalogNumber: optional(row.catalogNumber),
    media: optional(row.media),
    releaseCountry: optional(row.releaseCountry),
    originalReleaseDate: optional(row.originalReleaseDate),
    totalDiscs: optional(row.totalDiscs),
    popularity: row.popularity,
    playCount: row.playCount,
    favoriteCount: row.favoriteCount,
    repostCount: row.repostCount,
    isExplicit: row.isExplicit,
    isAvailable: row.isAvailable,
    primaryColor: optional(row.primaryColor),
    secondaryColor: optional(row.secondaryColor),
    source: optional(row.source),
    externalIds: compact({
      isrc: optional(row.externalIsrc),
      musicbrainzReleaseId: optional(row.externalMusicbrainzReleaseId),
    }),
    sources: context.sources ? [...context.sources] : undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

// ── Artist ────────────────────────────────────────────────────────────────

export interface ArtistDtoContext {
  readonly strikes?: readonly { reason: string; createdAt: string; trackId?: string }[];
  readonly sources?: readonly SourceProvenance[];
}

/**
 * `catalog_entities` rows of `type: 'artist'`.
 *
 * `imageSuggestions` and `images` cannot be named at all — `publicColumns()`
 * removes them from {@link PublicCatalogEntityRow}, which is the whole point.
 *
 * ## `members` was absent here, on a claim that was already known to be false
 *
 * This comment used to read: "`members` is deliberately absent: it stayed a
 * `jsonb` column with no reader anywhere, so naming it here would put a field on
 * the wire that nothing produces and nothing consumes."
 *
 * Every clause of that is wrong. `services/uploads/enrichCatalogEntity.ts`
 * WRITES it from Wikidata's `has part`; `controllers/entityProfile.controller.ts`
 * puts it on `GET /api/p/:id`; `@syra/shared-types`'s `entityProfileSchema` and
 * `artistSchema` both declare it; `entityProfile.artistSections.test.ts` asserts
 * a group's first member by name on a live response.
 *
 * Task 10b established all of that and corrected `schema/catalog.ts` in both
 * places — its file header and the column's own doc comment — and the claim
 * survived HERE, in the one file where it decided what reaches a client. That is
 * the "grep the claim" rule failing across files rather than within one, and the
 * cost is specific: an allowlist DTO drops silently, so porting the entity
 * profile through this function would have removed `members` from a live
 * response with nothing to catch it but the one test that happens to assert it.
 */
export function toArtistDto(
  row: PublicCatalogEntityRow,
  lookup: ImageVariantLookup,
  context: ArtistDtoContext = {}
): Artist {
  const stats: ArtistStats = {
    followers: row.statsFollowers ?? 0,
    albums: row.statsAlbums ?? 0,
    tracks: row.statsTracks ?? 0,
    totalPlays: row.statsTotalPlays ?? 0,
    monthlyListeners: optional(row.statsMonthlyListeners),
  };

  return {
    id: row.id,
    name: row.name,
    nameKey: optional(row.nameKey),
    bio: optional(row.bio),
    image: normalizeImageRef(row.imageId),
    imageSizes: toImageSizes(
      {
        small: row.imageSizesSmallId,
        medium: row.imageSizesMediumId,
        large: row.imageSizesLargeId,
        xlarge: row.imageSizesXlargeId,
        xxlarge: row.imageSizesXxlargeId,
        original: row.imageSizesOriginalId,
      },
      lookup
    ),
    imageLicence: toImageLicence(
      row.imageLicenceLicence,
      row.imageLicenceLicenceUrl,
      row.imageLicenceAttribution,
      row.imageLicenceSourceUrl
    ),
    genres: optional(row.genres),
    members: optional(row.members),
    verified: optional(row.verified),
    sortName: optional(row.sortName),
    disambiguation: optional(row.disambiguation),
    artistType: optional(row.artistType),
    activeFrom: optional(row.activeFrom),
    activeUntil: optional(row.activeUntil),
    aliases: optional(row.aliases),
    labels: optional(row.labels),
    popularity: row.popularity,
    primaryColor: optional(row.primaryColor),
    secondaryColor: optional(row.secondaryColor),
    ownerOxyUserId: optional(row.ownerOxyUserId),
    stats,
    strikeCount: optional(row.strikeCount),
    strikes: context.strikes ? [...context.strikes] : undefined,
    uploadsDisabled: optional(row.uploadsDisabled),
    lastStrikeAt: isoOptional(row.lastStrikeAt),
    terminated: optional(row.terminated),
    terminatedAt: isoOptional(row.terminatedAt),
    terminationReason: optional(row.terminationReason),
    // `source` is REQUIRED on the DTO and a CHECK constraint makes it non-null
    // for every `type = 'artist'` row, so this coalesce is unreachable for an
    // artist and exists only because the COLUMN is shared with `person` rows.
    source: row.source ?? 'upload',
    externalIds: compact({
      isrc: optional(row.externalIsrc),
      musicbrainzArtistId: optional(row.externalMusicbrainzArtistId),
      isni: optional(row.externalIsni),
      ipi: optional(row.externalIpi),
      wikidataId: optional(row.externalWikidataId),
      discogsArtistId: optional(row.externalDiscogsArtistId),
    }),
    sources: context.sources ? [...context.sources] : undefined,
    links: compact({
      website: optional(row.linksWebsite),
      instagram: optional(row.linksInstagram),
      x: optional(row.linksX),
      youtube: optional(row.linksYoutube),
      discogs: optional(row.linksDiscogs),
      wikidata: optional(row.linksWikidata),
      wikipedia: optional(row.linksWikipedia),
      bandcamp: optional(row.linksBandcamp),
      soundcloud: optional(row.linksSoundcloud),
    }),
    country: optional(row.country),
    claimable: optional(row.claimable),
    claimedByOxyUserId: optional(row.claimedByOxyUserId),
    origin: optional(row.origin),
    acceptsContributions: optional(row.acceptsContributions),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

// ── Playlist ──────────────────────────────────────────────────────────────

export interface PlaylistDtoContext {
  readonly collaborators?: readonly PlaylistCollaborator[];
  readonly sources?: readonly SourceProvenance[];
}

export function toPlaylistDto(
  row: PlaylistRow,
  lookup: ImageVariantLookup,
  context: PlaylistDtoContext = {}
): Playlist {
  return {
    id: row.id,
    name: row.name,
    description: optional(row.description),
    ownerOxyUserId: row.ownerOxyUserId,
    ownerUsername: row.ownerUsername,
    coverArt: normalizeImageRef(row.coverArtId),
    coverArtSizes: toImageSizes(
      {
        small: row.coverArtSizesSmallId,
        medium: row.coverArtSizesMediumId,
        large: row.coverArtSizesLargeId,
        xlarge: row.coverArtSizesXlargeId,
        xxlarge: row.coverArtSizesXxlargeId,
        original: row.coverArtSizesOriginalId,
      },
      lookup
    ),
    visibility: row.visibility,
    trackCount: row.trackCount,
    totalDuration: row.totalDuration,
    followers: row.followers,
    primaryColor: optional(row.primaryColor),
    secondaryColor: optional(row.secondaryColor),
    collaborators: context.collaborators ? [...context.collaborators] : undefined,
    source: optional(row.source),
    externalIds: compact({ isrc: optional(row.externalIsrc) }),
    sources: context.sources ? [...context.sources] : undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
