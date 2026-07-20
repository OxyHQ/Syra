// Base entrypoint: the platform-agnostic API client + schemas. The live-rooms
// engine is intentionally NOT re-exported here — it needs react-native peers, so it
// ships from `./index.native`, which the `exports` map serves to the `react-native`
// and `browser` conditions. A Node consumer resolving `@syra.fm/sdk` gets THIS file
// and will not find the live exports; that is by design, not a missing export.
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
