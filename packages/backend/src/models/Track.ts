import mongoose, { Schema, Document } from 'mongoose';
import { Track, TrackMetadata, AudioSource } from '@syra/shared-types';

export interface ITrack extends Omit<Track, 'id'>, Document {
  _id: mongoose.Types.ObjectId;
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

const TrackSchema = new Schema<ITrack>({
  title: { type: String, required: true, index: true },
  artistId: { type: String, required: true, index: true },
  artistName: { type: String, required: true, index: true },
  albumId: { type: String, index: true },
  albumName: { type: String },
  duration: { type: Number, required: true }, // in seconds
  trackNumber: { type: Number },
  discNumber: { type: Number },
  audioSource: { type: AudioSourceSchema, required: true },
  coverArt: { type: String },
  metadata: { type: TrackMetadataSchema },
  isExplicit: { type: Boolean, default: false, index: true },
  popularity: { type: Number, default: 0, min: 0, max: 100 },
  playCount: { type: Number, default: 0 },
  isAvailable: { type: Boolean, default: true, index: true },
  copyrightRemoved: { type: Boolean, default: false, index: true },
  removedAt: { type: Date },
  removedReason: { type: String },
  removedBy: { type: String }, // Oxy user ID who reported/removed
  copyrightReportId: { type: String },
}, {
  timestamps: true,
});

// Indexes for common queries
TrackSchema.index({ artistId: 1, albumId: 1 });
TrackSchema.index({ title: 'text', artistName: 'text' }); // Text search
TrackSchema.index({ popularity: -1 });
TrackSchema.index({ createdAt: -1 });

export const TrackModel = mongoose.model<ITrack>('Track', TrackSchema);

