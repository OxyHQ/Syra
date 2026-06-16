import { UserMusicPreferencesModel, IUserMusicPreferences } from '../models/UserMusicPreferences';
import type { AudioQuality } from '@syra/shared-types';

const AUDIO_QUALITY_VALUES: readonly AudioQuality[] = ['low', 'normal', 'high', 'very_high'];

/**
 * Ensure user music preferences exist (create with defaults if not)
 */
export async function ensureMusicPreferences(oxyUserId: string): Promise<IUserMusicPreferences> {
  let preferences = await UserMusicPreferencesModel.findOne({ oxyUserId }).lean();
  
  if (!preferences) {
    // Create with defaults
    const newPreferences = new UserMusicPreferencesModel({
      oxyUserId,
      defaultVolume: 0.7,
      autoplay: true,
      crossfade: 0,
      gaplessPlayback: true,
      normalizeVolume: true,
      explicitContent: true,
    });
    preferences = (await newPreferences.save()).toObject();
  }
  
  return preferences as IUserMusicPreferences;
}

/**
 * Get music preferences for a user
 */
export async function getMusicPreferences(oxyUserId: string): Promise<IUserMusicPreferences | null> {
  return await UserMusicPreferencesModel.findOne({ oxyUserId }).lean() as IUserMusicPreferences | null;
}

/**
 * Update music preferences for a user
 */
export async function updateMusicPreferences(
  oxyUserId: string,
  updates: Partial<IUserMusicPreferences>
): Promise<IUserMusicPreferences> {
  const update: Record<string, any> = {};
  
  // Validate and set defaultVolume
  if (typeof updates.defaultVolume === 'number') {
    const volume = Math.max(0, Math.min(1, updates.defaultVolume));
    update.defaultVolume = volume;
  }
  
  // Validate and set autoplay
  if (typeof updates.autoplay === 'boolean') {
    update.autoplay = updates.autoplay;
  }
  
  // Validate and set crossfade (0-12 seconds)
  if (typeof updates.crossfade === 'number') {
    const crossfade = Math.max(0, Math.min(12, updates.crossfade));
    update.crossfade = crossfade;
  }
  
  // Validate and set gaplessPlayback
  if (typeof updates.gaplessPlayback === 'boolean') {
    update.gaplessPlayback = updates.gaplessPlayback;
  }
  
  // Validate and set normalizeVolume
  if (typeof updates.normalizeVolume === 'boolean') {
    update.normalizeVolume = updates.normalizeVolume;
  }
  
  // Validate and set explicitContent
  if (typeof updates.explicitContent === 'boolean') {
    update.explicitContent = updates.explicitContent;
  }

  // Validate and set audioQuality
  if (typeof updates.audioQuality === 'string' && AUDIO_QUALITY_VALUES.includes(updates.audioQuality as AudioQuality)) {
    update.audioQuality = updates.audioQuality;
  }

  // Validate and set downloadQuality
  if (typeof updates.downloadQuality === 'string' && AUDIO_QUALITY_VALUES.includes(updates.downloadQuality as AudioQuality)) {
    update.downloadQuality = updates.downloadQuality;
  }

  // Validate and set dataSaver
  if (typeof updates.dataSaver === 'boolean') {
    update.dataSaver = updates.dataSaver;
  }

  // Validate and set monoAudio
  if (typeof updates.monoAudio === 'boolean') {
    update.monoAudio = updates.monoAudio;
  }

  // Update or create preferences
  const preferences = await UserMusicPreferencesModel.findOneAndUpdate(
    { oxyUserId },
    { $set: update },
    { upsert: true, new: true }
  ).lean();
  
  if (!preferences) {
    throw new Error('Failed to update music preferences');
  }
  
  return preferences as IUserMusicPreferences;
}






