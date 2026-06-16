import mongoose, { Schema, Document } from 'mongoose';

/**
 * RecentlyPlayed - one document per play event. The home screen resolves the
 * most recent DISTINCT tracks (newest first) from these per-play records, so
 * playing a track again simply adds a newer row and the older one drops off the
 * deduped list. Storage is capped per user (see `recordRecentlyPlayed`) to keep
 * the collection bounded.
 */
export interface IRecentlyPlayed extends Document {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  trackId: string;
  playedAt: Date;
  createdAt: string;
  updatedAt: string;
}

const RecentlyPlayedSchema = new Schema<IRecentlyPlayed>({
  oxyUserId: { type: String, required: true, index: true },
  trackId: { type: String, required: true, index: true },
  playedAt: { type: Date, required: true, default: () => new Date() },
}, {
  timestamps: true,
});

// Primary read pattern: a user's plays ordered newest first.
RecentlyPlayedSchema.index({ oxyUserId: 1, playedAt: -1 });

export const RecentlyPlayedModel = mongoose.model<IRecentlyPlayed>('RecentlyPlayed', RecentlyPlayedSchema);
