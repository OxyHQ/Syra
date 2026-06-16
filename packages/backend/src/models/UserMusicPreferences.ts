import mongoose, { Schema, Document } from 'mongoose';
import type { AudioQuality } from '@syra/shared-types';

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
  audioQuality: AudioQuality;
  downloadQuality: AudioQuality;
  dataSaver: boolean;
  monoAudio: boolean;
  createdAt: string;
  updatedAt: string;
}

const AUDIO_QUALITY_VALUES: AudioQuality[] = ['low', 'normal', 'high', 'very_high'];

const UserMusicPreferencesSchema = new Schema<IUserMusicPreferences>({
  oxyUserId: { type: String, required: true, unique: true, index: true },
  defaultVolume: { type: Number, default: 0.7, min: 0, max: 1 },
  autoplay: { type: Boolean, default: true },
  crossfade: { type: Number, default: 0, min: 0, max: 12 },
  gaplessPlayback: { type: Boolean, default: true },
  normalizeVolume: { type: Boolean, default: true },
  explicitContent: { type: Boolean, default: true },
  audioQuality: { type: String, enum: AUDIO_QUALITY_VALUES, default: 'normal' },
  downloadQuality: { type: String, enum: AUDIO_QUALITY_VALUES, default: 'normal' },
  dataSaver: { type: Boolean, default: false },
  monoAudio: { type: Boolean, default: false },
}, {
  timestamps: true,
});

export const UserMusicPreferencesModel: mongoose.Model<IUserMusicPreferences> =
  (mongoose.models.UserMusicPreferences as mongoose.Model<IUserMusicPreferences>) ??
  mongoose.model<IUserMusicPreferences>('UserMusicPreferences', UserMusicPreferencesSchema);
