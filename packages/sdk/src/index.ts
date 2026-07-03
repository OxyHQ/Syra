export {
  createSyraClient,
  DEFAULT_SYRA_BASE_URL,
  DEFAULT_SYRA_WEB_BASE_URL,
} from './client';
export type {
  SyraClient,
  SyraClientOptions,
  SearchTracksOptions,
  SearchPodcastsOptions,
  PodcastEpisodesOptions,
  SearchPage,
  ArtworkSource,
  PodcastArtworkSource,
  EpisodeArtworkSource,
} from './client';
export {
  trackSummarySchema,
  podcastSummarySchema,
  episodeSummarySchema,
  coverArtSizesSchema,
  coverArtVariantSchema,
} from './schema';
export type {
  TrackSummary,
  PodcastSummary,
  EpisodeSummary,
  CoverArtSizes,
  CoverArtVariant,
  ArtworkSize,
} from './schema';
export { SyraApiError } from './errors';
