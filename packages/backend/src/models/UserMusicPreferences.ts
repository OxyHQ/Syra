import mongoose, { Schema, Document } from 'mongoose';

/**
 * UserMusicPreferences - User music settings and preferences
 */
export interface IUserMusicPreferences extends Document {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  defaultVolume: number; // 0-1
  autoplay: boolean; // autoplay similar songs
  crossfade: number; // crossfade duration in seconds (0 = disabled)
  gaplessPlayback: boolean;
  normalizeVolume: boolean;
  explicitContent: boolean; // allow explicit content
  createdAt: string;
  updatedAt: string;
}

const UserMusicPreferencesSchema = new Schema<IUserMusicPreferences>({
  oxyUserId: { type: String, required: true, unique: true, index: true },
  defaultVolume: { type: Number, default: 0.7, min: 0, max: 1 },
  autoplay: { type: Boolean, default: true },
  crossfade: { type: Number, default: 0, min: 0, max: 12 },
  gaplessPlayback: { type: Boolean, default: true },
  normalizeVolume: { type: Boolean, default: true },
  explicitContent: { type: Boolean, default: true },
}, {
  timestamps: true,
});

export const UserMusicPreferencesModel = mongoose.model<IUserMusicPreferences>('UserMusicPreferences', UserMusicPreferencesSchema);






