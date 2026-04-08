import { UserMusicPreferencesModel, IUserMusicPreferences } from '../models/UserMusicPreferences';

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






