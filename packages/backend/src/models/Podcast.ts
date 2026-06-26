import mongoose, { Schema, Document } from 'mongoose';
import {
  Podcast,
  PodcastFunding,
  PodcastProvenanceProvider,
  PodcastSourceProvenance,
} from '@syra/shared-types';
import type { CatalogImageSizes } from '@syra/shared-types/track';

export interface IPodcast
  extends Omit<
      Podcast,
      'id' | '_id' | 'createdAt' | 'updatedAt' | 'lastRefreshedAt' | 'lastEpisodeAt' | 'linkedArtistId'
    >,
    Document {
  _id: mongoose.Types.ObjectId;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  lastRefreshedAt?: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  lastEpisodeAt?: Date;
  linkedArtistId?: mongoose.Types.ObjectId;
}

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

const PodcastFundingSchema = new Schema<PodcastFunding>({
  url: { type: String, required: true },
  message: { type: String },
}, { _id: false });

const PodcastSourceProvenanceSchema = new Schema<PodcastSourceProvenance>({
  provider: {
    type: String,
    enum: ['rss', 'syra', 'podcastindex', 'apple'] as PodcastProvenanceProvider[],
    required: true,
  },
  externalId: { type: String, required: true },
  importedAt: { type: String, required: true },
  fields: [{ type: String }],
}, { _id: false });

const PodcastSchema = new Schema<IPodcast>({
  // Identity
  title: { type: String, required: true, index: true },
  description: { type: String },
  author: { type: String, index: true },
  image: { type: String },
  imageSizes: { type: CatalogImageSizesSchema },
  language: { type: String },
  categories: [{ type: String, index: true }],
  explicit: { type: Boolean, default: false },
  link: { type: String },
  type: { type: String, enum: ['episodic', 'serial'], default: 'episodic' },
  // Feed identity
  feedUrl: { type: String },
  podcastGuid: { type: String },
  podcastIndexId: { type: Number },
  appleCollectionId: { type: Number },
  // Origin
  source: { type: String, enum: ['rss', 'syra'], required: true, index: true },
  // Linking
  ownerOxyUserId: { type: String },
  claimable: { type: Boolean, index: true },
  claimedByOxyUserId: { type: String },
  linkedArtistId: { type: Schema.Types.ObjectId, ref: 'Artist' },
  // Refresh / HTTP conditional-GET cache
  lastRefreshedAt: { type: Date },
  refreshIntervalMin: { type: Number, default: 60 },
  etag: { type: String },
  lastModified: { type: String },
  episodeCount: { type: Number, default: 0 },
  lastEpisodeAt: { type: Date },
  // Signals
  popularity: { type: Number, default: 0, min: 0, max: 100 },
  subscriberCount: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'unavailable', 'removed'], default: 'active', index: true },
  // Optional Podcasting 2.0
  funding: [{ type: PodcastFundingSchema }],
  value: { type: Schema.Types.Mixed },
  // Provenance
  sources: [{ type: PodcastSourceProvenanceSchema }],
}, {
  timestamps: true,
});

// Feed identity: unique when present (Syra-hosted shows may not carry a feedUrl).
PodcastSchema.index({ feedUrl: 1 }, { unique: true, sparse: true });
PodcastSchema.index({ podcastGuid: 1 }, { unique: true, sparse: true });
PodcastSchema.index({ podcastIndexId: 1 }, { sparse: true });
PodcastSchema.index({ appleCollectionId: 1 }, { sparse: true });
// Browse / search
PodcastSchema.index({ title: 'text', author: 'text' });
PodcastSchema.index({ popularity: -1 });
PodcastSchema.index({ lastEpisodeAt: -1 });
// Linking lookups
PodcastSchema.index({ ownerOxyUserId: 1 }, { sparse: true });
PodcastSchema.index({ claimedByOxyUserId: 1 }, { sparse: true });
PodcastSchema.index({ linkedArtistId: 1 }, { sparse: true });

export const PodcastModel: mongoose.Model<IPodcast> =
  (mongoose.models.Podcast as mongoose.Model<IPodcast>) ??
  mongoose.model<IPodcast>('Podcast', PodcastSchema);
