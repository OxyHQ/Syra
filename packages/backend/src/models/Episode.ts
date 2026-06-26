import mongoose, { Schema, Document } from 'mongoose';
import {
  Episode,
  AudioSource,
  HlsRendition,
  EpisodeChapters,
  EpisodeTranscript,
  EpisodePerson,
} from '@syra/shared-types';
import type { CatalogImageSizes } from '@syra/shared-types/track';

/** Hybrid-audio cache state for an RSS episode (Date-typed `cachedAt` in MongoDB). */
export interface IEpisodeCache {
  status: 'none' | 'cached' | 'hls';
  s3Key?: string;
  hlsMasterKey?: string;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  cachedAt?: Date;
}

export interface IEpisode
  extends Omit<Episode, 'id' | '_id' | 'createdAt' | 'updatedAt' | 'podcastId' | 'pubDate' | 'cache'>,
    Document {
  _id: mongoose.Types.ObjectId;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
  podcastId: mongoose.Types.ObjectId;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  pubDate: Date;
  cache?: IEpisodeCache;
}

const AudioSourceSchema = new Schema<AudioSource>({
  url: { type: String, required: true },
  format: { type: String, enum: ['mp3', 'flac', 'ogg', 'm4a', 'wav'], required: true },
  bitrate: { type: Number },
  duration: { type: Number },
}, { _id: false });

const HlsRenditionSchema = new Schema<HlsRendition>({
  manifestKey: { type: String, required: true },
  bitrateKbps: { type: Number, required: true },
  encrypted: { type: Boolean, required: true },
}, { _id: false });

const CatalogImageVariantSchema = new Schema({
  id: { type: String, required: true },
  url: { type: String, required: true },
  width: { type: Number, required: true },
  height: { type: Number, required: true },
}, { _id: false });

const CatalogImageSizesSchema = new Schema<CatalogImageSizes>({
  small: { type: CatalogImageVariantSchema },
  medium: { type: CatalogImageVariantSchema },
  large: { type: CatalogImageVariantSchema },
  xlarge: { type: CatalogImageVariantSchema },
  xxlarge: { type: CatalogImageVariantSchema },
  original: { type: CatalogImageVariantSchema },
}, { _id: false });

const EpisodeCacheSchema = new Schema<IEpisodeCache>({
  status: { type: String, enum: ['none', 'cached', 'hls'], default: 'none' },
  s3Key: { type: String },
  hlsMasterKey: { type: String },
  cachedAt: { type: Date },
}, { _id: false });

const EpisodeChaptersSchema = new Schema<EpisodeChapters>({
  url: { type: String, required: true },
  type: { type: String, required: true },
}, { _id: false });

const EpisodeTranscriptSchema = new Schema<EpisodeTranscript>({
  url: { type: String, required: true },
  type: { type: String, required: true },
  language: { type: String },
}, { _id: false });

const EpisodePersonSchema = new Schema<EpisodePerson>({
  name: { type: String, required: true },
  role: { type: String },
  group: { type: String },
  img: { type: String },
  href: { type: String },
}, { _id: false });

const EpisodeSchema = new Schema<IEpisode>({
  podcastId: { type: Schema.Types.ObjectId, ref: 'Podcast', required: true, index: true },
  podcastTitle: { type: String, required: true },
  title: { type: String, required: true, index: true },
  description: { type: String },
  summary: { type: String },
  guid: { type: String, required: true },
  // Origin enclosure (RSS); absent for Syra-hosted episodes
  enclosureUrl: { type: String },
  enclosureType: { type: String },
  enclosureLength: { type: Number },
  duration: { type: Number, default: 0 },
  pubDate: { type: Date, required: true, index: true },
  season: { type: Number },
  episodeNumber: { type: Number },
  episodeType: { type: String, enum: ['full', 'trailer', 'bonus'], default: 'full' },
  image: { type: String },
  imageSizes: { type: CatalogImageSizesSchema },
  // Colors from the episode's own art (only when it carries distinct artwork).
  primaryColor: { type: String },
  secondaryColor: { type: String },
  // Original external episode-art URL, kept as a fallback when re-hosting fails.
  imageSourceUrl: { type: String },
  explicit: { type: Boolean, default: false },
  // Podcasting 2.0
  chapters: { type: EpisodeChaptersSchema },
  transcripts: [{ type: EpisodeTranscriptSchema }],
  persons: [{ type: EpisodePersonSchema }],
  // Hybrid audio
  source: { type: String, enum: ['rss', 'syra'], required: true, index: true },
  cache: { type: EpisodeCacheSchema },
  audioSource: { type: AudioSourceSchema },
  hls: [{ type: HlsRenditionSchema }],
  hlsMasterKey: { type: String },
  // Signals
  playCount: { type: Number, default: 0 },
  popularity: { type: Number, default: 0, min: 0, max: 100 },
  status: { type: String, enum: ['ready', 'processing', 'failed', 'unavailable'], default: 'ready', index: true },
}, {
  timestamps: true,
});

// One episode per feed guid.
EpisodeSchema.index({ podcastId: 1, guid: 1 }, { unique: true });
// Reverse-chronological listing within a show.
EpisodeSchema.index({ podcastId: 1, pubDate: -1 });
EpisodeSchema.index({ title: 'text' });
EpisodeSchema.index({ popularity: -1 });
EpisodeSchema.index({ pubDate: -1 });

export const EpisodeModel: mongoose.Model<IEpisode> =
  (mongoose.models.Episode as mongoose.Model<IEpisode>) ??
  mongoose.model<IEpisode>('Episode', EpisodeSchema);
