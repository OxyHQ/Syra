import mongoose, { Schema, Document } from 'mongoose';
import { EpisodeProgress } from '@syra/shared-types';

/**
 * EpisodeProgress - per-user playback position for a podcast episode. Powers
 * "continue listening", resume-on-load, and the played/completed dot. One
 * document per (user, episode); upserted on pause/seek/unmount.
 */
export interface IEpisodeProgress
  extends Omit<EpisodeProgress, 'id' | '_id' | 'createdAt' | 'updatedAt' | 'episodeId'>,
    Document {
  _id: mongoose.Types.ObjectId;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
  episodeId: mongoose.Types.ObjectId;
}

const EpisodeProgressSchema = new Schema<IEpisodeProgress>({
  oxyUserId: { type: String, required: true, index: true },
  episodeId: { type: Schema.Types.ObjectId, ref: 'Episode', required: true, index: true },
  positionSec: { type: Number, required: true, default: 0 },
  durationSec: { type: Number, required: true, default: 0 },
  completed: { type: Boolean, default: false, index: true },
}, {
  timestamps: true,
});

// One progress record per user per episode.
EpisodeProgressSchema.index({ oxyUserId: 1, episodeId: 1 }, { unique: true });
// "Continue listening": a user's in-progress episodes, most recent first.
EpisodeProgressSchema.index({ oxyUserId: 1, updatedAt: -1 });

export const EpisodeProgressModel: mongoose.Model<IEpisodeProgress> =
  (mongoose.models.EpisodeProgress as mongoose.Model<IEpisodeProgress>) ??
  mongoose.model<IEpisodeProgress>('EpisodeProgress', EpisodeProgressSchema);
