// Base entrypoint: the platform-agnostic API client and its types. The live-rooms
// engine is intentionally NOT re-exported here — it needs react-native peers, so it
// ships from `./index.native`, which the `exports` map serves to the `react-native`
// and `browser` conditions. A Node consumer resolving `@syra.fm/sdk` gets THIS file
// and will not find the live exports; that is by design, not a missing export.
export {
  createSyraClient,
  DEFAULT_SYRA_BASE_URL,
  DEFAULT_SYRA_WEB_BASE_URL,
} from './client';
export { sendAudioUpload } from './upload';
export type { SendAudioUploadOptions } from './upload';
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
  CreatePodcastInput,
  UpdatePodcastInput,
  CreateEpisodeDraftInput,
  IngestEpisodeInput,
  UploadPayload,
} from './client';
export type {
  TrackSummary,
  PodcastSummary,
  PodcastSubscription,
  PodcastVisibility,
  EpisodeSummary,
  EpisodeAudioSource,
  EpisodeStatus,
  EpisodeDraft,
  AudioUploadTarget,
  EpisodeStream,
  PodcastDeleted,
  EpisodeDeleted,
  UploadedImage,
  CoverArtSizes,
  CoverArtVariant,
  ArtworkSize,
  PublicPodcastCard,
  PublicPodcastCardsResponse,
  PublicApiErrorCode,
} from './types';
// The Zod schemas are NOT exported here: this entry is what apps bundle, and
// Zod (with its locales) is ~500 KiB of JavaScript for a check the client does
// in plain TypeScript. Server consumers import them from `@syra.fm/sdk/schemas`.
export { SyraApiError, SyraResponseError } from './errors';

export { syraForOxySession } from './oxy';
export type { SyraLinkedIdentity, SyraSessionOptions } from './oxy';
