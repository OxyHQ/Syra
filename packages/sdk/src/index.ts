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
  SearchPage,
  ArtworkSource,
  PodcastArtworkSource,
} from './client';
export {
  trackSummarySchema,
  podcastSummarySchema,
  coverArtSizesSchema,
  coverArtVariantSchema,
} from './schema';
export type {
  TrackSummary,
  PodcastSummary,
  CoverArtSizes,
  CoverArtVariant,
  ArtworkSize,
} from './schema';
export { SyraApiError } from './errors';
