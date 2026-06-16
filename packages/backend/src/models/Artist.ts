import mongoose, { Schema, Document } from 'mongoose';
import {
  Artist,
  ArtistStats,
  CatalogSource,
  ExternalIds,
  SourceProvenance,
  TrackImage,
} from '@syra/shared-types';

export interface IArtist extends Omit<Artist, 'id'>, Document {
  _id: mongoose.Types.ObjectId;
}

const ArtistStatsSchema = new Schema<ArtistStats>({
  followers: { type: Number, default: 0 },
  albums: { type: Number, default: 0 },
  tracks: { type: Number, default: 0 },
  totalPlays: { type: Number, default: 0 },
  monthlyListeners: { type: Number, default: 0 },
}, { _id: false });

const StrikeSchema = new Schema({
  reason: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  trackId: { type: String },
}, { _id: true });

const ExternalIdsSchema = new Schema<ExternalIds>({
  isrc: { type: String },
  audiusId: { type: String },
}, { _id: false });

const SourceProvenanceSchema = new Schema<SourceProvenance>({
  provider: { type: String, enum: ['upload', 'cc', 'audius'] as CatalogSource[], required: true },
  externalId: { type: String, required: true },
  importedAt: { type: String, required: true },
  fields: [{ type: String }],
}, { _id: false });

const ArtistImageSchema = new Schema<TrackImage>({
  url: { type: String, required: true },
  width: { type: Number },
  height: { type: Number },
  source: { type: String, enum: ['upload', 'cc', 'audius'] as CatalogSource[] },
}, { _id: false });

const ArtistSchema = new Schema<IArtist>({
  // name is no longer unique: multi-source catalog can have same name across providers
  name: { type: String, required: true, index: true },
  bio: { type: String },
  image: { type: String }, // own S3 MongoDB ObjectId; converted to /api/images/:id in API responses
  genres: [{ type: String, index: true }],
  verified: { type: Boolean, default: false, index: true },
  popularity: { type: Number, default: 0, min: 0, max: 100 },
  primaryColor: { type: String },
  secondaryColor: { type: String },
  ownerOxyUserId: { type: String }, // Link artist to user
  stats: { type: ArtistStatsSchema, default: () => ({
    followers: 0,
    albums: 0,
    tracks: 0,
    totalPlays: 0,
    monthlyListeners: 0,
  }) },
  strikeCount: { type: Number, default: 0, min: 0 },
  strikes: [{ type: StrikeSchema }],
  uploadsDisabled: { type: Boolean, default: false, index: true },
  lastStrikeAt: { type: Date },
  // Catalog provenance
  source: { type: String, enum: ['upload', 'cc', 'audius'] as CatalogSource[], required: true, index: true },
  externalIds: { type: ExternalIdsSchema },
  sources: [{ type: SourceProvenanceSchema }],
  images: [{ type: ArtistImageSchema }],
  links: {
    type: new Schema({
      website: { type: String },
      instagram: { type: String },
      x: { type: String },
      youtube: { type: String },
    }, { _id: false }),
  },
  country: { type: String },
  claimable: { type: Boolean, index: true },
  claimedByOxyUserId: { type: String },
}, {
  timestamps: true,
});

// Indexes for common queries
ArtistSchema.index({ name: 'text' }); // Text search
ArtistSchema.index({ popularity: -1 });
ArtistSchema.index({ 'stats.followers': -1 });
ArtistSchema.index({ verified: 1, popularity: -1 });
ArtistSchema.index({ ownerOxyUserId: 1 }); // Index for user-artist queries
// External identifier lookups
ArtistSchema.index({ 'externalIds.audiusId': 1 }, { sparse: true });

export const ArtistModel: mongoose.Model<IArtist> =
  (mongoose.models.Artist as mongoose.Model<IArtist>) ??
  mongoose.model<IArtist>('Artist', ArtistSchema);
