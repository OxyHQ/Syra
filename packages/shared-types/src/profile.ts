import { z } from 'zod';

export const profileVisibilitySchema = z.enum([
  'public',
  'private',
  'followers_only',
]);
export type ProfileVisibility = z.infer<typeof profileVisibilitySchema>;
export const ProfileVisibility = {
  PUBLIC: 'public' as const,
  PRIVATE: 'private' as const,
  FOLLOWERS_ONLY: 'followers_only' as const,
};

export const profileTypeSchema = z.enum([
  'personal',
  'business',
  'creator',
  'verified',
]);
export type ProfileType = z.infer<typeof profileTypeSchema>;
export const ProfileType = {
  PERSONAL: 'personal' as const,
  BUSINESS: 'business' as const,
  CREATOR: 'creator' as const,
  VERIFIED: 'verified' as const,
};

export const personalInfoSchema = z.object({
  bio: z.string().optional(),
  displayName: z.string().optional(),
  username: z.string(),
  avatar: z.string().optional(),
  banner: z.string().optional(),
  location: z.string().optional(),
  website: z.string().optional(),
  birthDate: z.string().optional(),
});
export type PersonalInfo = z.infer<typeof personalInfoSchema>;

export const profileNotificationSettingsSchema = z.object({
  email: z.boolean(),
  push: z.boolean(),
  sms: z.boolean(),
  postNotifications: z.boolean().optional(),
  mentionNotifications: z.boolean().optional(),
  followNotifications: z.boolean().optional(),
  likeNotifications: z.boolean().optional(),
  repostNotifications: z.boolean().optional(),
});
export type ProfileNotificationSettings = z.infer<typeof profileNotificationSettingsSchema>;

export const privacySettingsSchema = z.object({
  profileVisibility: profileVisibilitySchema,
  showContactInfo: z.boolean(),
});
export type PrivacySettings = z.infer<typeof privacySettingsSchema>;

export const themeModeSchema = z.enum(['light', 'dark', 'system']);
export type ThemeMode = z.infer<typeof themeModeSchema>;

export const appearanceSettingsSchema = z.object({
  themeMode: themeModeSchema,
  primaryColor: z.string().optional(),
});
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;

export const profileSettingsSchema = z.object({
  notifications: profileNotificationSettingsSchema,
  privacy: privacySettingsSchema,
  language: z.string(),
  timezone: z.string(),
  currency: z.string().optional(),
  appearance: appearanceSettingsSchema.optional(),
});
export type ProfileSettings = z.infer<typeof profileSettingsSchema>;

export const profileStatsSchema = z.object({
  postsCount: z.number(),
  followersCount: z.number(),
  followingCount: z.number(),
  likesCount: z.number(),
  repostsCount: z.number(),
});
export type ProfileStats = z.infer<typeof profileStatsSchema>;

export const profileSchema = z.object({
  id: z.string(),
  _id: z.string().optional(),
  oxyUserId: z.string(),
  profileType: profileTypeSchema,
  isPrimary: z.boolean(),
  isActive: z.boolean(),
  personalInfo: personalInfoSchema,
  settings: profileSettingsSchema,
  stats: profileStatsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Profile = z.infer<typeof profileSchema>;

export const oxyUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  avatar: z.string().optional(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OxyUser = z.infer<typeof oxyUserSchema>;

export const profileWithOxyUserSchema = z.object({
  profile: profileSchema,
  oxyUser: oxyUserSchema,
});
export type ProfileWithOxyUser = z.infer<typeof profileWithOxyUserSchema>;
