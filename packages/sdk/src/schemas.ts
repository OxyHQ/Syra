// `@syra.fm/sdk/schemas` — the SDK's response contract as Zod schemas, for
// SERVER-side consumers (a backend test asserting its route answers exactly what
// the SDK accepts). Deliberately a separate entry: the client and the live-rooms
// engine check the same shapes without Zod, so an app bundling them does not
// carry Zod and its locales. Importing this entry is what brings Zod in.
export {
  trackSummarySchema,
  podcastSummarySchema,
  podcastSubscriptionSchema,
  podcastVisibilitySchema,
  episodeSummarySchema,
  episodeAudioSourceSchema,
  episodeStatusSchema,
  episodeDraftSchema,
  episodeStreamSchema,
  podcastDeletedSchema,
  episodeDeletedSchema,
  uploadedImageSchema,
  coverArtSizesSchema,
  coverArtVariantSchema,
} from './schema';
export {
  ZRoom,
  ZRoomParticipant,
  ZHouse,
  ZHouseMember,
  ZHouseVisibility,
  ZSeries,
  ZRecurrence,
  ZRoomTemplate,
  ZSeriesEpisode,
  ZRoomAttachment,
  ZPodcastQueueItem,
  ZStartStreamResponse,
  ZGenerateStreamKeyResponse,
  ZStreamInfo,
  ZRecording,
} from './live/schema';
export type {
  TrackSummary,
  PodcastSummary,
  PodcastSubscription,
  PodcastVisibility,
  EpisodeSummary,
  EpisodeAudioSource,
  EpisodeStatus,
  EpisodeDraft,
  EpisodeStream,
  PodcastDeleted,
  EpisodeDeleted,
  UploadedImage,
  CoverArtSizes,
  CoverArtVariant,
} from './types';
export type {
  Room,
  RoomParticipant,
  House,
  HouseMember,
  HouseVisibility,
  Series,
  SeriesEpisode,
  Recurrence,
  RoomTemplate,
  RoomAttachment,
  Recording,
  PodcastQueueItem,
} from './live/validation';
