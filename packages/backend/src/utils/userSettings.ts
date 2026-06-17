import UserSettings, { IUserSettings } from '../models/UserSettings';

/**
 * Default profile customization settings
 */
export const DEFAULT_PROFILE_CUSTOMIZATION = {
  coverPhotoEnabled: true,
  minimalistMode: false,
} as const;

/**
 * Ensures a UserSettings document exists for a user
 * Creates with defaults if missing, updates if missing profileCustomization
 */
type UserSettingsLean = Pick<
  IUserSettings,
  'oxyUserId' | 'appearance' | 'profileHeaderImage' | 'profileCustomization'
>;

export async function ensureUserSettings(oxyUserId: string) {
  let doc = await UserSettings.findOne({ oxyUserId }).lean<UserSettingsLean>();
  
  if (!doc) {
    const created = await UserSettings.create({ 
      oxyUserId,
      profileCustomization: DEFAULT_PROFILE_CUSTOMIZATION,
    });
    doc = created.toObject() as UserSettingsLean;
  } else if (!doc.profileCustomization) {
    doc = await UserSettings.findOneAndUpdate(
      { oxyUserId },
      { $set: { profileCustomization: DEFAULT_PROFILE_CUSTOMIZATION } },
      { new: true }
    ).lean<UserSettingsLean>();
  }
  
  return doc;
}

/**
 * Extracts public profile design data from UserSettings document
 */
export function extractPublicProfileData(doc: Pick<IUserSettings, 'appearance' | 'profileHeaderImage' | 'profileCustomization'> | null | undefined, userId: string) {
  return {
    oxyUserId: userId,
    appearance: doc?.appearance?.primaryColor ? {
      primaryColor: doc.appearance.primaryColor,
    } : undefined,
    profileHeaderImage: doc?.profileHeaderImage,
    profileCustomization: doc?.profileCustomization || DEFAULT_PROFILE_CUSTOMIZATION,
  };
}
