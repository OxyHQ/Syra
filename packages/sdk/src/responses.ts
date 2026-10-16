import { SyraResponseError } from './errors';
import {
  EPISODE_STATUSES,
  PODCAST_VISIBILITIES,
  PUBLIC_API_ERROR_CODES,
  type CoverArtSizes,
  type CoverArtVariant,
  type EpisodeAudioSource,
  type EpisodeDeleted,
  type EpisodeDraft,
  type EpisodeStream,
  type EpisodeSummary,
  type PodcastDeleted,
  type PodcastSubscription,
  type PodcastSummary,
  type PublicApiErrorCode,
  type PublicPodcastCard,
  type PublicPodcastCardsResponse,
  type TrackSummary,
  type UploadedImage,
} from './types';
import {
  array,
  boolean,
  formatPath,
  number,
  object,
  oneOf,
  optional,
  refine,
  string,
  type Validator,
} from './validate';

/**
 * The runtime checks for every response the client hands back. Each one keeps
 * exactly the fields of its type and drops the rest; see `./validate` for the
 * rules and `./schema` for the same contract in Zod.
 */

const coverArtVariant = object<CoverArtVariant>({
  id: optional(string),
  url: string,
  width: optional(number),
  height: optional(number),
  fileId: optional(string),
  variant: optional(string),
});

const coverArtSizes = object<CoverArtSizes>({
  small: optional(coverArtVariant),
  medium: optional(coverArtVariant),
  large: optional(coverArtVariant),
  xlarge: optional(coverArtVariant),
  xxlarge: optional(coverArtVariant),
  original: optional(coverArtVariant),
});

export const trackSummary = object<TrackSummary>({
  id: string,
  title: string,
  artistId: optional(string),
  artistName: string,
  albumId: optional(string),
  albumName: optional(string),
  duration: number,
  coverArt: optional(string),
  coverArtSizes: optional(coverArtSizes),
  previewAvailable: optional(boolean),
});

export const podcastSummary = object<PodcastSummary>({
  id: string,
  title: string,
  author: optional(string),
  description: optional(string),
  image: optional(string),
  imageSizes: optional(coverArtSizes),
  imageSourceUrl: optional(string),
  visibility: optional(oneOf(PODCAST_VISIBILITIES)),
  aiGenerated: optional(boolean),
});

export const podcastSubscription = object<PodcastSubscription>({
  podcast: podcastSummary,
  lastEpisodeAt: optional(string),
});

const episodeAudioSource = object<EpisodeAudioSource>({
  url: string,
  format: optional(string),
  bitrate: optional(number),
  duration: optional(number),
});

export const episodeSummary = object<EpisodeSummary>({
  id: string,
  podcastId: string,
  title: string,
  description: optional(string),
  enclosureUrl: optional(string),
  enclosureType: optional(string),
  enclosureLength: optional(number),
  audioSource: optional(episodeAudioSource),
  duration: optional(number),
  pubDate: optional(string),
  season: optional(number),
  episodeNumber: optional(number),
  status: optional(oneOf(EPISODE_STATUSES)),
  aiGenerated: optional(boolean),
  image: optional(string),
  imageSizes: optional(coverArtSizes),
  imageSourceUrl: optional(string),
});

export const episodeDraft = object<EpisodeDraft>({
  episodeId: string,
  ingestTicket: string,
  expiresAt: string,
});

export const podcastDeleted = object<PodcastDeleted>({
  id: string,
  episodesDeleted: number,
  objectsDeleted: number,
});

export const episodeDeleted = object<EpisodeDeleted>({
  id: string,
  podcastId: string,
  objectsDeleted: number,
});

export const episodeStream = object<EpisodeStream>({
  url: string,
  type: string,
  expiresAt: optional(string),
});

export const uploadedImage = object<UploadedImage>({
  id: string,
  fileId: optional(string),
  primaryColor: optional(string),
  secondaryColor: optional(string),
});

/** An opaque show id as `@syra.fm/contracts` bounds it: 1–256 characters, no edge whitespace. */
export const publicPodcastId = refine(
  string,
  (id) => id.length >= 1 && id.length <= 256 && id.trim() === id,
  'expected a podcast id of 1–256 characters without surrounding whitespace',
);

/**
 * Only `http(s)` — a card's URLs become an image source and a link in another
 * app, where a `javascript:` or `data:` value would be the caller's problem.
 */
const httpUrl = refine(string, (url) => /^https?:\/\/\S+$/i.test(url), 'expected an http(s) URL');

const publicPodcastCard = object<PublicPodcastCard>({
  id: publicPodcastId,
  title: string,
  author: optional(string),
  artworkUrl: optional(httpUrl),
  showUrl: httpUrl,
});

export const publicPodcastCardsResponse = object<PublicPodcastCardsResponse>({
  items: array(publicPodcastCard),
  unavailableIds: array(publicPodcastId),
});

/** The `{ error: { code, message } }` body every public route answers an error with. */
export const publicApiError = object<{ error: { code: PublicApiErrorCode; message: string } }>({
  error: object({ code: oneOf(PUBLIC_API_ERROR_CODES), message: string }),
});

/** The checked value, or `undefined` — for list rows, where one bad row is skipped. */
export function checkRow<T>(validator: Validator<T>, input: unknown): T | undefined {
  const checked = validator(input, []);
  return checked.ok ? checked.value : undefined;
}

/** The checked value, or a {@link SyraResponseError} naming `method` and the failing field. */
export function checkResponse<T>(validator: Validator<T>, input: unknown, method: string): T {
  const checked = validator(input, []);
  if (checked.ok) return checked.value;
  const { path, message } = checked.issue;
  throw new SyraResponseError(
    method,
    path,
    `Syra API response failed validation at ${formatPath(path)}: ${message} (${method})`,
  );
}
