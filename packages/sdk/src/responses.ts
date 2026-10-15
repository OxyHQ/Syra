import { SyraResponseError } from './errors';
import {
  EPISODE_STATUSES,
  PODCAST_VISIBILITIES,
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
  type TrackSummary,
  type UploadedImage,
} from './types';
import {
  boolean,
  formatPath,
  number,
  object,
  oneOf,
  optional,
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
  primaryColor: optional(string),
  secondaryColor: optional(string),
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
