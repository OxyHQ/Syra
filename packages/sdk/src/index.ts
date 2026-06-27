export {
  createSyraClient,
  DEFAULT_SYRA_BASE_URL,
} from './client';
export type {
  SyraClient,
  SyraClientOptions,
  SearchTracksOptions,
  ArtworkSource,
} from './client';
export {
  trackSummarySchema,
  coverArtSizesSchema,
  coverArtVariantSchema,
} from './schema';
export type {
  TrackSummary,
  CoverArtSizes,
  CoverArtVariant,
  ArtworkSize,
} from './schema';
export { SyraApiError } from './errors';
