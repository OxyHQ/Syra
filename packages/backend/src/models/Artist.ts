import mongoose, { Schema, Document } from 'mongoose';
import { Artist, ArtistStats } from '@syra/shared-types';

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

const ArtistSchema = new Schema<IArtist>({
  name: { type: String, required: true, index: true, unique: true },
  bio: { type: String },
  image: { type: String },
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
}, {
  timestamps: true,
});

// Indexes for common queries
ArtistSchema.index({ name: 'text' }); // Text search
ArtistSchema.index({ popularity: -1 });
ArtistSchema.index({ 'stats.followers': -1 });
ArtistSchema.index({ verified: 1, popularity: -1 });
ArtistSchema.index({ ownerOxyUserId: 1 }); // Index for user-artist queries

export const ArtistModel = mongoose.model<IArtist>('Artist', ArtistSchema);

