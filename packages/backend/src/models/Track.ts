import mongoose, { Schema, Document } from 'mongoose';
import {
  Track,
  TrackMetadata,
  AudioSource,
  CatalogSource,
  ExternalIds,
  SourceProvenance,
  TrackImage,
  HlsRendition,
} from '@syra/shared-types';

export interface ITrack
  extends Omit<Track, 'id' | '_id' | 'createdAt' | 'updatedAt' | 'removedAt' | 'releaseDate'>,
    Document {
  _id: mongoose.Types.ObjectId;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  removedAt?: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  releaseDate?: Date;
}

const AudioSourceSchema = new Schema<AudioSource>({
  url: { type: String, required: true },
  format: { type: String, enum: ['mp3', 'flac', 'ogg', 'm4a', 'wav'], required: true },
  bitrate: { type: Number },
  duration: { type: Number },
}, { _id: false });

const TrackMetadataSchema = new Schema<TrackMetadata>({
  genre: [{ type: String }],
  bpm: { type: Number },
  key: { type: String },
  explicit: { type: Boolean, default: false },
  language: { type: String },
  isrc: { type: String },
  copyright: { type: String },
  publisher: { type: String },
}, { _id: false });

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

const TrackImageSchema = new Schema<TrackImage>({
  url: { type: String, required: true },
  width: { type: Number },
  height: { type: Number },
  source: { type: String, enum: ['upload', 'cc', 'audius'] as CatalogSource[] },
}, { _id: false });

const HlsRenditionSchema = new Schema<HlsRendition>({
  manifestKey: { type: String, required: true },
  bitrateKbps: { type: Number, required: true },
  encrypted: { type: Boolean, required: true },
}, { _id: false });

const TrackSchema = new Schema<ITrack>({
  title: { type: String, required: true, index: true },
  artistId: { type: String, required: true, index: true },
  artistName: { type: String, required: true, index: true },
  albumId: { type: String, index: true },
  albumName: { type: String },
  duration: { type: Number, required: true }, // in seconds
  trackNumber: { type: Number },
  discNumber: { type: Number },
  audioSource: { type: AudioSourceSchema }, // optional: absent for audius/processing tracks
  coverArt: { type: String },
  metadata: { type: TrackMetadataSchema },
  // Provider-supplied descriptive metadata (e.g. Audius genre/mood/tags)
  genre: { type: String, index: true },
  mood: { type: String, index: true },
  tags: [{ type: String, index: true }],
  releaseDate: { type: Date },
  isExplicit: { type: Boolean, default: false, index: true },
  popularity: { type: Number, default: 0, min: 0, max: 100 },
  playCount: { type: Number, default: 0 },
  favoriteCount: { type: Number, default: 0 },
  repostCount: { type: Number, default: 0 },
  isAvailable: { type: Boolean, default: true, index: true },
  copyrightRemoved: { type: Boolean, default: false, index: true },
  removedAt: { type: Date },
  removedReason: { type: String },
  removedBy: { type: String }, // Oxy user ID who reported/removed
  copyrightReportId: { type: String },
  // Catalog provenance
  source: { type: String, enum: ['upload', 'cc', 'audius'] as CatalogSource[], required: true, index: true },
  status: { type: String, enum: ['processing', 'ready', 'failed'], default: 'ready', index: true },
  externalIds: { type: ExternalIdsSchema },
  sources: [{ type: SourceProvenanceSchema }],
  images: [{ type: TrackImageSchema }],
  hls: [{ type: HlsRenditionSchema }],
  loudnessLufs: { type: Number },
  streamUrl: { type: String },
  hlsMasterKey: { type: String },
}, {
  timestamps: true,
});

// Indexes for common queries
TrackSchema.index({ artistId: 1, albumId: 1 });
TrackSchema.index({ title: 'text', artistName: 'text' }); // Text search
TrackSchema.index({ popularity: -1 });
TrackSchema.index({ playCount: -1 });
TrackSchema.index({ createdAt: -1 });
// External identifier lookups
TrackSchema.index({ 'externalIds.isrc': 1 }, { unique: true, sparse: true });
TrackSchema.index({ 'externalIds.audiusId': 1 }, { sparse: true });

export const TrackModel: mongoose.Model<ITrack> =
  (mongoose.models.Track as mongoose.Model<ITrack>) ??
  mongoose.model<ITrack>('Track', TrackSchema);
