/**
 * The public Syra API response shapes this SDK hands back. Intentionally NOT
 * shared with the Syra backend's internal types — the SDK checks only the fields
 * it returns and drops everything else, so the API can evolve without breaking
 * external consumers.
 *
 * The runtime checks are in `./responses`; the same contract as Zod schemas, for
 * server-side consumers, is `@syra.fm/sdk/schemas`.
 */

/**
 * A single artwork variant. The backend serializes `url` as `/api/images/:id`,
 * which serves the bytes (or redirects to them) for every variant.
 *
 * `fileId` and `variant` are present when the artwork is stored in Oxy Files:
 * the Oxy file id and the Oxy rendition name (`thumb`, `w320`, … — absent for
 * the original). A client that has Oxy's image resolver (`assets.publicUrl`)
 * resolves those directly instead of going through `url`.
 */
export interface CoverArtVariant {
  id?: string;
  url: string;
  width?: number;
  height?: number;
  fileId?: string;
  variant?: string;
}

/** Named artwork variants keyed by size. */
export interface CoverArtSizes {
  small?: CoverArtVariant;
  medium?: CoverArtVariant;
  large?: CoverArtVariant;
  xlarge?: CoverArtVariant;
  xxlarge?: CoverArtVariant;
  original?: CoverArtVariant;
}

/** Artwork size name. */
export type ArtworkSize = keyof CoverArtSizes;

/**
 * The summary view of a track returned by the public catalog endpoints — just
 * enough to render a song row and play its preview.
 */
export interface TrackSummary {
  id: string;
  title: string;
  artistId?: string;
  artistName: string;
  albumId?: string;
  albumName?: string;
  duration: number;
  coverArt?: string;
  coverArtSizes?: CoverArtSizes;
  previewAvailable?: boolean;
}

export const PODCAST_VISIBILITIES = ['private', 'unlisted', 'public'] as const;
export type PodcastVisibility = (typeof PODCAST_VISIBILITIES)[number];

/**
 * The summary view of a podcast SHOW returned by the public podcast endpoints
 * (`GET /api/podcasts/search`, `GET /api/podcasts/:id`) — just enough to render
 * a show card and deep-link into the Syra app.
 *
 * Artwork mirrors tracks: `image` is the re-hosted Syra image id (resolved via
 * `/api/images/:id`); `imageSizes` is the multi-resolution variant set (each
 * variant `url` is `/api/images/:id`); `imageSourceUrl` keeps the original
 * external artwork URL as an absolute fallback when re-hosting has not run yet.
 */
export interface PodcastSummary {
  id: string;
  title: string;
  author?: string;
  description?: string;
  image?: string;
  imageSizes?: CoverArtSizes;
  imageSourceUrl?: string;
  /**
   * Who may see this show. OPTIONAL here although the API always sends it: a
   * published SDK is installed against whatever version of the API a consumer
   * happens to be pointing at, and requiring a field the previous release did
   * not send would make this SDK reject every response from it.
   */
  visibility?: PodcastVisibility;
  /** Disclosure: the show's content was machine-generated. Optional, same reason. */
  aiGenerated?: boolean;
}

/**
 * One show the caller is subscribed to, from `GET /api/podcasts/subscriptions`.
 * `lastEpisodeAt` is the newest episode's publish time — what a client compares
 * against its own last visit to badge a show with new episodes.
 */
export interface PodcastSubscription {
  podcast: PodcastSummary;
  lastEpisodeAt?: string;
}

/**
 * Where a Syra-hosted episode's audio actually is.
 *
 * `url` is a PATH on the Syra API (`/api/podcasts/episodes/:id/audio`), not an
 * absolute URL — resolve it with `SyraClient.episodeAudioUrl` rather than
 * handing it to a player directly.
 */
export interface EpisodeAudioSource {
  url: string;
  format?: string;
  bitrate?: number;
  duration?: number;
}

/**
 * An episode's processing state. `ready` is playable; `processing` is an episode
 * whose audio is still being packaged (including one drafted but not yet
 * ingested), and only its OWNER is shown those.
 */
export const EPISODE_STATUSES = ['ready', 'processing', 'failed', 'unavailable'] as const;
export type EpisodeStatus = (typeof EPISODE_STATUSES)[number];

/**
 * The summary view of a podcast EPISODE returned by the public podcast endpoints
 * (`GET /api/podcasts/:id/episodes`, `GET /api/episodes/:id`) — just enough to
 * list an episode and stream its audio.
 *
 * ## `enclosureUrl` is OPTIONAL, and that is a bug fix rather than a loosening
 *
 * It used to be required, on the reasoning that "an episode with no enclosure is
 * unplayable, so a row missing it is malformed". That reasoning holds only for
 * RSS-mirrored episodes. A SYRA-HOSTED episode — everything created through
 * `createPodcast`/`uploadEpisode`/the ingest ticket — has no enclosure at all:
 * its audio lives at `audioSource.url`, a path on the Syra API. So the required
 * field made this SDK silently DROP every Syra-hosted episode from
 * `getPodcastEpisodes` and throw on one from `getEpisode` — the entire
 * first-party catalogue, invisible, with no error to notice.
 *
 * The two are alternatives, not a required field and an optional one:
 *
 *   enclosureUrl      an ABSOLUTE external URL (RSS mirror)
 *   audioSource.url   a PATH on the Syra API (Syra-hosted)
 *
 * `SyraClient.episodeAudioUrl` is the one place that resolves either into
 * something playable, so no consumer has to know which kind it holds.
 *
 * `enclosureType` / `enclosureLength` describe the external file (MIME type and
 * byte length); `duration` is the runtime in seconds and `pubDate` the ISO
 * publish timestamp.
 *
 * Artwork mirrors the podcast SHOW: `image` is the re-hosted Syra image id
 * (resolved via `/api/images/:id`); `imageSizes` is the multi-resolution variant
 * set (each variant `url` is `/api/images/:id`); `imageSourceUrl` keeps the
 * original external artwork URL as an absolute fallback when re-hosting has not
 * run yet.
 */
export interface EpisodeSummary {
  id: string;
  podcastId: string;
  title: string;
  description?: string;
  /** ABSOLUTE, and present only for RSS-mirrored episodes — see the note above. */
  enclosureUrl?: string;
  enclosureType?: string;
  enclosureLength?: number;
  /** A PATH on the Syra API, present for Syra-hosted episodes. */
  audioSource?: EpisodeAudioSource;
  duration?: number;
  pubDate?: string;
  season?: number;
  episodeNumber?: number;
  status?: EpisodeStatus;
  /** Disclosure: this episode's content was machine-generated. */
  aiGenerated?: boolean;
  image?: string;
  imageSizes?: CoverArtSizes;
  imageSourceUrl?: string;
}

/** What `createEpisodeDraft` hands back: the episode to fill, and the capability to fill it. */
export interface EpisodeDraft {
  episodeId: string;
  ingestTicket: string;
  expiresAt: string;
}

/**
 * What `deletePodcast` hands back — a receipt, and it is worth reading rather
 * than discarding.
 *
 * Both counts are of things that were actually removed by THIS call, so they are
 * how a caller mirroring the delete elsewhere can tell a real deletion from a
 * no-op. `objectsDeleted` counts stored objects (source audio, manifests and
 * every segment beside them); a show whose episodes were never ingested reports
 * zero for both, which is a success, not a failure.
 */
export interface PodcastDeleted {
  id: string;
  episodesDeleted: number;
  objectsDeleted: number;
}

/** What `deleteEpisode` hands back. `podcastId` names the show it was removed from. */
export interface EpisodeDeleted {
  id: string;
  podcastId: string;
  objectsDeleted: number;
}

/** What `getEpisodeStream` hands back: a tokenized HLS URL with its own deadline. */
export interface EpisodeStream {
  url: string;
  type: string;
  expiresAt?: string;
}

/** What the image upload endpoint hands back. */
export interface UploadedImage {
  id: string;
  /** The Oxy file the image is stored as, owned by the uploader's account. */
  fileId?: string;
  primaryColor?: string;
  secondaryColor?: string;
}

/**
 * One current, public podcast show as `getPublicPodcastCards` hands it back —
 * what a third-party app needs to render a reference card, and nothing an owner
 * or a session could change. The wire contract (Zod and OpenAPI) is
 * `@syra.fm/contracts`; this is the same shape without Zod.
 */
export interface PublicPodcastCard {
  id: string;
  title: string;
  author?: string;
  /** An absolute `http(s)` URL. */
  artworkUrl?: string;
  /** The show's page on the Syra web app, an absolute `http(s)` URL. */
  showUrl: string;
}

/**
 * Every requested id appears exactly once: in `items` when it is a current
 * active public show, otherwise in `unavailableIds` (missing, private, unlisted
 * or withdrawn — the batch does not say which).
 */
export interface PublicPodcastCardsResponse {
  items: PublicPodcastCard[];
  unavailableIds: string[];
}

/** The `error.code` of a structured public-API error body. */
export const PUBLIC_API_ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'rate_limited',
  'internal_error',
  'service_unavailable',
] as const;
export type PublicApiErrorCode = (typeof PUBLIC_API_ERROR_CODES)[number];
