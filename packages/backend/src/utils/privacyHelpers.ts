/**
 * Privacy visibility constants
 */
export const ProfileVisibility = {
  PUBLIC: 'public',
  PRIVATE: 'private',
  FOLLOWERS_ONLY: 'followers_only',
} as const;

export type ProfileVisibilityType = typeof ProfileVisibility[keyof typeof ProfileVisibility];

type UnknownRecord = Record<string, unknown>;
function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object';
}

function toUserId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value._id === 'string') return value._id;
  return undefined;
}

function extractPrivacyList(response: unknown, key: 'following' | 'followers'): unknown[] {
  if (isRecord(response) && Array.isArray(response[key])) {
    return response[key];
  }
  return Array.isArray(response) ? response : [];
}

/**
 * Extract user ID from blocked/restricted user entry
 * Handles different response formats from Oxy API
 */
export function extractUserIdFromBlockedRestricted(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  
  if (entry.blockedId) {
    return toUserId(entry.blockedId);
  }
  if (entry.restrictedId) {
    return toUserId(entry.restrictedId);
  }
  return toUserId(entry.id) ?? toUserId(entry._id) ?? toUserId(entry.userId) ?? toUserId(entry.targetId);
}

/**
 * Extract user IDs from Oxy following response
 * Handles various response formats from Oxy API
 */
export function extractFollowingIds(followingRes: unknown): string[] {
  const followingList = extractPrivacyList(followingRes, 'following');
  
  return followingList
    .map((u: unknown) => {
      if (typeof u === 'string') return u;
      if (!isRecord(u)) return undefined;
      return toUserId(u.id)
        ?? toUserId(u._id)
        ?? toUserId(u.userId)
        ?? toUserId(isRecord(u.user) ? u.user.id : undefined)
        ?? toUserId(isRecord(u.profile) ? u.profile.id : undefined)
        ?? toUserId(u.targetId);
    })
    .filter((id): id is string => Boolean(id));
}

/**
 * Extract user IDs from Oxy followers response
 * Handles various response formats from Oxy API
 */
export function extractFollowersIds(followersRes: unknown): string[] {
  const followersList = extractPrivacyList(followersRes, 'followers');
  
  return followersList
    .map((entry: unknown) => {
      if (typeof entry === 'string') {
        return entry;
      }
      if (!isRecord(entry)) return undefined;
      return toUserId(entry.id)
        ?? toUserId(entry._id)
        ?? toUserId(entry.userId)
        ?? toUserId(entry.oxyUserId)
        ?? toUserId(isRecord(entry.user) ? entry.user.id : undefined)
        ?? toUserId(isRecord(entry.profile) ? entry.profile.id : undefined)
        ?? toUserId(entry.targetId);
    })
    .filter((id): id is string => Boolean(id));
}

/**
 * Check if a profile requires access check (private or followers_only)
 */
export function requiresAccessCheck(profileVisibility: string | undefined): boolean {
  return profileVisibility === ProfileVisibility.PRIVATE || 
         profileVisibility === ProfileVisibility.FOLLOWERS_ONLY;
}
