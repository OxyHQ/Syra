/**
 * Podcast and episode serialization, on drizzle — the replacement for
 * `services/podcasts/podcastSerializers.ts`.
 *
 * Same allowlist discipline as `db/catalog/serialize.ts`, and for the same
 * reason: the Mongo serializers here were already hand-written object literals
 * rather than spreads, but they took a DOCUMENT — `_id`, `podcastId` and every
 * date arrived as `ObjectId`/`Date`, and six fields arrived as embedded
 * subdocument arrays that are child TABLES now. Handing a drizzle row to the old
 * function type-checked (its input was a structural type with every field
 * optional-ish) and produced `{"id": undefined}` plus four silently missing
 * collections. Every function below names its row type and its context.
 *
 * ## What moved out of the row and has to be handed in
 *
 * Six arrays became child tables and one became a junction, so a DTO cannot be
 * built from a `podcasts`/`episodes` row alone:
 *
 *   `podcast.categories`  ← `podcast_categories` → `genres.name`
 *   `podcast.funding`     ← `podcast_funding`
 *   `podcast.persons`     ← `podcast_persons`
 *   `podcast.sources`     ← `podcast_sources`
 *   `episode.transcripts` ← `episode_transcripts`
 *   `episode.persons`     ← `episode_persons`
 *   `episode.hls`         ← `episode_hls_renditions`
 *
 * Each is OPT-IN on the context, exactly as `TrackDtoContext` treats credits and
 * sources: a browse shelf renders a title and a cover and must not pay seven
 * joins per page for fields nothing on it shows. `db/podcasts/hydrate.ts` is
 * where a caller says which it wants, in one batch query per collection.
 *
 * ## `null` is not `undefined`
 *
 * Every optional field in `@syra/shared-types` is `.optional()`, never
 * `.nullable()`, so a Postgres `null` handed straight through fails the SDK's
 * own parse. {@link optional} converts once; {@link compact} drops a nested
 * object whose parts are all absent, which is what a missing Mongo subdocument
 * looked like on the wire.
 *
 * ## `cache.s3Key` and the two HLS keys stay on the wire
 *
 * `episodeSchema` declares all three and the Mongo serializer emitted all three,
 * so they are named here. That is PARITY, not an endorsement — they are S3
 * object keys, and whether a public episode DTO should carry them is a product
 * question this port does not get to answer unilaterally. Recorded so the next
 * reader knows it was seen rather than missed.
 */

import type {
  AudioSource,
  CatalogImageSizes,
  CatalogImageVariant,
  Episode,
  EpisodeChapters,
  EpisodePerson,
  EpisodeTranscript,
  HlsRendition,
  Podcast,
  PodcastFunding,
  PodcastPerson,
  PodcastSourceProvenance,
} from '@syra/shared-types';
import { isLiveEntityId } from '@oxyhq/db';
import type { episodes, podcasts } from '../schema/podcasts';

// ── Row shapes ────────────────────────────────────────────────────────────
//
// Neither table protects a column (`schema/protectedColumns.ts`), so the whole
// row is public and these are the plain inferred types. They are still written
// out rather than used inline, so a column added tomorrow shows up as a type a
// serializer does not name rather than as a field that silently ships.

export type PodcastRow = typeof podcasts.$inferSelect;
export type EpisodeRow = typeof episodes.$inferSelect;

/** Resolves an `image_assets` id to its rendered variant — `db/catalog/serialize.ts`'s. */
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
 * Identical to `db/catalog/serialize.ts`'s, and deliberately duplicated rather
 * than imported: this module must not depend on the catalog serializer, and the
 * one-line body is not a shared abstraction — `isLiveEntityId` is.
 */
function normalizeImageRef(value: string | null): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.startsWith('/api/images/')) return value;
  return isLiveEntityId(value) ? `/api/images/${value}` : undefined;
}

/** The six per-variant FK columns, in the order the DTO declares them. */
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

/**
 * The artwork bundle a cover-less episode inherits from its parent show.
 *
 * The Mongo version of this was a projection string
 * (`PODCAST_ARTWORK_PROJECTION = 'image imageSizes imageSourceUrl primaryColor
 * secondaryColor'`) plus a structural interface nothing checked against it. Here
 * it is built by {@link podcastArtwork} from a real row, so the two cannot
 * disagree about which fields inheritance covers.
 */
export interface PodcastArtwork {
  image?: string;
  imageSizes?: CatalogImageSizes;
  imageSourceUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
}

/** The inheritable artwork of one show. */
export function podcastArtwork(row: PodcastRow, lookup: ImageVariantLookup): PodcastArtwork {
  return {
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
    imageSourceUrl: optional(row.imageSourceUrl),
    primaryColor: optional(row.primaryColor),
    secondaryColor: optional(row.secondaryColor),
  };
}

/** Every `image_assets` id a `podcasts` row can reference. */
export function podcastImageIds(row: PodcastRow): (string | null)[] {
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

/** Every `image_assets` id an `episodes` row can reference. */
export function episodeImageIds(row: EpisodeRow): (string | null)[] {
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

// ── Podcast ───────────────────────────────────────────────────────────────

/** The child-table collections a caller chose to load for a show. */
export interface PodcastDtoContext {
  readonly categories?: readonly string[];
  readonly funding?: readonly PodcastFunding[];
  readonly persons?: readonly PodcastPerson[];
  readonly sources?: readonly PodcastSourceProvenance[];
}

export function toPodcastDto(
  row: PodcastRow,
  lookup: ImageVariantLookup,
  context: PodcastDtoContext = {}
): Podcast {
  const artwork = podcastArtwork(row, lookup);

  return {
    id: row.id,
    title: row.title,
    description: optional(row.description),
    author: optional(row.author),
    image: artwork.image,
    imageSizes: artwork.imageSizes,
    primaryColor: artwork.primaryColor,
    secondaryColor: artwork.secondaryColor,
    imageSourceUrl: artwork.imageSourceUrl,
    language: optional(row.language),
    categories: context.categories ? [...context.categories] : undefined,
    explicit: row.explicit,
    link: optional(row.link),
    type: row.type,
    feedUrl: optional(row.feedUrl),
    podcastGuid: optional(row.podcastGuid),
    podcastIndexId: optional(row.podcastIndexId),
    appleCollectionId: optional(row.appleCollectionId),
    source: row.source,
    ownerOxyUserId: optional(row.ownerOxyUserId),
    claimable: optional(row.claimable),
    claimedByOxyUserId: optional(row.claimedByOxyUserId),
    linkedArtistId: optional(row.linkedArtistId),
    lastRefreshedAt: isoOptional(row.lastRefreshedAt),
    refreshIntervalMin: row.refreshIntervalMin,
    etag: optional(row.etag),
    lastModified: optional(row.lastModified),
    episodeCount: row.episodeCount,
    lastEpisodeAt: isoOptional(row.lastEpisodeAt),
    needsDeepImport: row.needsDeepImport,
    popularity: row.popularity,
    subscriberCount: row.subscriberCount,
    status: row.status,
    funding: context.funding ? [...context.funding] : undefined,
    persons: context.persons ? [...context.persons] : undefined,
    value: optional(row.value),
    sources: context.sources ? [...context.sources] : undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

// ── Episode ───────────────────────────────────────────────────────────────

/** The child-table collections a caller chose to load for an episode. */
export interface EpisodeDtoContext {
  readonly transcripts?: readonly EpisodeTranscript[];
  readonly persons?: readonly EpisodePerson[];
  readonly hls?: readonly HlsRendition[];
}

/**
 * `podcastArtwork` is REQUIRED (not optional) so a new call site cannot silently
 * forget it and ship cover-less episodes; pass `undefined` explicitly when the
 * parent show's artwork genuinely is not available. Carried over verbatim from
 * the Mongo serializer, which had the same signature for the same reason.
 */
export function toEpisodeDto(
  row: EpisodeRow,
  lookup: ImageVariantLookup,
  showArtwork: PodcastArtwork | undefined,
  context: EpisodeDtoContext = {}
): Episode {
  /**
   * Artwork inheritance: `row.imageId` — the re-hosted Syra cover — is the
   * canonical "this episode has its own art" signal. When it is absent the
   * episode inherits the WHOLE bundle from its show, so clients render
   * `episode.image`/`imageSizes`/`imageSourceUrl` + colors with no special
   * casing. Note the test is on the raw COLUMN rather than on
   * `normalizeImageRef`'s output: a stored id that fails `isLiveEntityId` still
   * means the episode has its own art, and falling back to the show's for it
   * would silently relabel a broken reference as the show's cover.
   */
  const art: PodcastArtwork = row.imageId
    ? {
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
        imageSourceUrl: optional(row.imageSourceUrl),
        primaryColor: optional(row.primaryColor),
        secondaryColor: optional(row.secondaryColor),
      }
    : (showArtwork ?? {});

  const audioSource: AudioSource | undefined =
    row.audioSourceUrl && row.audioSourceFormat
      ? {
          url: row.audioSourceUrl,
          format: row.audioSourceFormat,
          ...(row.audioSourceBitrate === null ? {} : { bitrate: row.audioSourceBitrate }),
          ...(row.audioSourceDuration === null ? {} : { duration: row.audioSourceDuration }),
        }
      : undefined;

  const chapters: EpisodeChapters | undefined =
    row.chaptersUrl && row.chaptersType
      ? { url: row.chaptersUrl, type: row.chaptersType }
      : undefined;

  return {
    id: row.id,
    podcastId: row.podcastId,
    podcastTitle: row.podcastTitle,
    title: row.title,
    description: optional(row.description),
    summary: optional(row.summary),
    guid: row.guid,
    enclosureUrl: optional(row.enclosureUrl),
    enclosureType: optional(row.enclosureType),
    enclosureLength: optional(row.enclosureLength),
    duration: row.duration,
    pubDate: iso(row.pubDate),
    season: optional(row.season),
    episodeNumber: optional(row.episodeNumber),
    episodeType: row.episodeType,
    image: art.image,
    imageSizes: art.imageSizes,
    primaryColor: art.primaryColor,
    secondaryColor: art.secondaryColor,
    imageSourceUrl: art.imageSourceUrl,
    explicit: row.explicit,
    chapters,
    transcripts: context.transcripts ? [...context.transcripts] : undefined,
    persons: context.persons ? [...context.persons] : undefined,
    source: row.source,
    /**
     * `cacheStatus` is the whole subdocument's presence signal — the Mongo
     * document either had a `cache` object or had none, and `schema/podcasts.ts`
     * flattened it with every column nullable and NO default precisely so that
     * distinction survives. A row with a null status emits no `cache` at all,
     * which is what an absent subdocument looked like.
     */
    cache: row.cacheStatus
      ? {
          status: row.cacheStatus,
          s3Key: optional(row.cacheObjectKey),
          hlsMasterKey: optional(row.cacheHlsMasterKey),
          cachedAt: isoOptional(row.cacheCachedAt),
        }
      : undefined,
    audioSource,
    hls: context.hls ? [...context.hls] : undefined,
    hlsMasterKey: optional(row.hlsMasterKey),
    playCount: row.playCount,
    popularity: row.popularity,
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
