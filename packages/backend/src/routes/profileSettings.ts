import { Router, Response } from 'express';
import { requireOxyAuth as requireAuth, type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId as getAuthenticatedUserId } from '@oxyhq/core/server';
import { deleteUserBehavior } from '../db/user/behavior';
import {
  ensureOwnUserSettings,
  ensurePublicUserSettings,
  updateUserSettings,
  type ProfileVisibility,
  type ThemeMode,
  type UserSettingsPatch,
} from '../db/user/settings';
import { PROFILE_VISIBILITIES, THEME_MODES } from '../db/schema/user';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';
import { sendErrorResponse, sendSuccessResponse, validateRequired } from '../utils/apiHelpers';
import { getParam } from '../utils/reqParams';

const router = Router();

/**
 * Profile Settings API
 * All routes require authentication
 *
 * ## `GET /settings/:userId` no longer serves one person's mute list to another
 *
 * Both GETs used to return the same document, and that document carried
 * `privacy.hiddenWords` and `privacy.restrictedUsers` — one account's muted words
 * and the accounts it has restricted — to ANY authenticated caller who asked for
 * ANY user id. `ensureUserSettings` narrowed the TypeScript type and never
 * projected, so nothing on the read path made the fields absent.
 *
 * The two routes now take different projections: `/settings/me` reads the
 * caller's own row whole, `/settings/:userId` reads someone else's without those
 * two columns. `db/user/settings.ts` holds the column lists and
 * `schema/protectedColumns.ts` is the structural guard behind them.
 *
 * ## `null` clears a field, and under Mongoose it did not
 *
 * Five fields below accept `null` to mean "clear this". The Mongo handler
 * expressed that by putting `undefined` in its `$set`, which Mongoose strips out
 * of an update — so every one of those branches was a no-op and the field kept
 * its old value. They work here. See {@link updateUserSettings}.
 */

// Apply auth middleware to all routes
router.use(requireAuth);

/**
 * GET /api/profile/settings/me
 * Get current user's settings
 */
router.get('/settings/me', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const doc = await ensureOwnUserSettings(oxyUserId);
    return sendSuccessResponse(res, 200, doc);
  } catch (err) {
    logger.error('[ProfileSettings] Error fetching my settings:', describeErrorSafely(err));
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch settings');
  }
});


/**
 * GET /api/profile/settings/:userId
 * Get settings by oxy user id
 *
 * Answers for any account, so it withholds the two server-only privacy lists —
 * including when the id happens to be the caller's own. `/settings/me` is the
 * route that returns them, and having exactly one route that can is what keeps
 * the rule checkable.
 */
router.get('/settings/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = getParam(req, 'userId');

    const validationError = validateRequired(userId, 'userId');
    if (validationError) {
      return sendErrorResponse(res, 400, 'Bad Request', validationError);
    }

    const doc = await ensurePublicUserSettings(userId);
    return sendSuccessResponse(res, 200, doc);
  } catch (err) {
    logger.error('[ProfileSettings] Error fetching user settings:', describeErrorSafely(err));
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch settings');
  }
});

/** A number clamped into range, or `undefined` when the input was not a number. */
function clamped(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' ? Math.max(min, Math.min(max, value)) : undefined;
}

/**
 * A trimmed string, `null` when the caller sent `null` or blanked it, and
 * `undefined` when they did not mention the field at all.
 *
 * The three-way result is the point: `undefined` leaves the column alone and
 * `null` clears it, which is the distinction `$set: { x: undefined }` could not
 * express. A string that trims to empty means "clear" for the same reason it did
 * in the Mongo handler — `.trim() || undefined` there, `null` here.
 */
function trimmedOrCleared(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

function isProfileVisibility(value: unknown): value is ProfileVisibility {
  return typeof value === 'string' && (PROFILE_VISIBILITIES as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Assign only when the caller supplied something — `undefined` means leave alone. */
function put<K extends keyof UserSettingsPatch>(
  patch: UserSettingsPatch,
  key: K,
  value: UserSettingsPatch[K] | undefined,
): void {
  if (value !== undefined) patch[key] = value;
}

/**
 * Turn a client body into a column patch.
 *
 * Every bound here has a matching CHECK constraint in `schema/user.ts`; clamping
 * rather than rejecting is the ported behaviour, and a clamp that drifted from
 * its constraint would turn a request the API used to accept into a `23514` the
 * caller cannot act on.
 */
function buildSettingsPatch(body: Record<string, unknown>): UserSettingsPatch {
  const patch: UserSettingsPatch = {};

  if (body.appearance) {
    const appearance = asRecord(body.appearance);
    if (isThemeMode(appearance.themeMode)) patch.appearanceThemeMode = appearance.themeMode;
    put(patch, 'appearancePrimaryColor', trimmedOrCleared(appearance.primaryColor));
  }

  if (typeof body.profileHeaderImage === 'string') {
    patch.profileHeaderImage = body.profileHeaderImage;
  }

  if (body.profileCustomization) {
    const customization = asRecord(body.profileCustomization);
    if (typeof customization.coverPhotoEnabled === 'boolean') {
      patch.profileCustomizationCoverPhotoEnabled = customization.coverPhotoEnabled;
    }
    if (typeof customization.minimalistMode === 'boolean') {
      patch.profileCustomizationMinimalistMode = customization.minimalistMode;
    }
    put(patch, 'profileCustomizationDisplayName', trimmedOrCleared(customization.displayName));
    put(patch, 'profileCustomizationCoverImage', trimmedOrCleared(customization.coverImage));
  }

  if (body.privacy) {
    const privacy = asRecord(body.privacy);
    if (typeof privacy.showContactInfo === 'boolean') patch.privacyShowContactInfo = privacy.showContactInfo;
    if (typeof privacy.allowTags === 'boolean') patch.privacyAllowTags = privacy.allowTags;
    if (typeof privacy.allowMentions === 'boolean') patch.privacyAllowMentions = privacy.allowMentions;
    if (typeof privacy.showOnlineStatus === 'boolean') patch.privacyShowOnlineStatus = privacy.showOnlineStatus;
    if (typeof privacy.hideLikeCounts === 'boolean') patch.privacyHideLikeCounts = privacy.hideLikeCounts;
    if (typeof privacy.hideShareCounts === 'boolean') patch.privacyHideShareCounts = privacy.hideShareCounts;
    if (typeof privacy.hideReplyCounts === 'boolean') patch.privacyHideReplyCounts = privacy.hideReplyCounts;
    if (typeof privacy.hideSaveCounts === 'boolean') patch.privacyHideSaveCounts = privacy.hideSaveCounts;

    if (isProfileVisibility(privacy.profileVisibility)) {
      patch.privacyProfileVisibility = privacy.profileVisibility;
    }
    if (Array.isArray(privacy.hiddenWords)) {
      patch.privacyHiddenWords = privacy.hiddenWords.filter((w): w is string => typeof w === 'string');
    }
    if (Array.isArray(privacy.restrictedUsers)) {
      patch.privacyRestrictedUsers = privacy.restrictedUsers.filter(
        (u): u is string => typeof u === 'string'
      );
    }
  }

  if (body.interests) {
    const interests = asRecord(body.interests);
    // An absent or null `tags` CLEARS the list — the Mongo handler's one
    // clearing path that actually worked, because it assigned `[]` rather than
    // `undefined`.
    patch.interestsTags = Array.isArray(interests.tags)
      ? interests.tags.filter((tag): tag is string => typeof tag === 'string')
      : [];
  }

  if (body.feedSettings) {
    const feed = asRecord(body.feedSettings);

    if (feed.diversity) {
      const diversity = asRecord(feed.diversity);
      if (typeof diversity.enabled === 'boolean') patch.feedDiversityEnabled = diversity.enabled;
      put(patch, 'feedDiversitySameAuthorPenalty', clamped(diversity.sameAuthorPenalty, 0.5, 1.0));
      put(patch, 'feedDiversitySameTopicPenalty', clamped(diversity.sameTopicPenalty, 0.5, 1.0));

      // The one bounded number the Mongo handler ROUNDED as well as clamped,
      // which is why its column is `integer` and the other four are not.
      if (typeof diversity.maxConsecutiveSameAuthor === 'number') {
        patch.feedDiversityMaxConsecutiveSameAuthor = Math.max(
          1,
          Math.min(10, Math.round(diversity.maxConsecutiveSameAuthor))
        );
      } else if (diversity.maxConsecutiveSameAuthor === null) {
        patch.feedDiversityMaxConsecutiveSameAuthor = null;
      }
    }

    if (feed.recency) {
      const recency = asRecord(feed.recency);
      put(patch, 'feedRecencyHalfLifeHours', clamped(recency.halfLifeHours, 6, 72));
      put(patch, 'feedRecencyMaxAgeHours', clamped(recency.maxAgeHours, 24, 336));
    }

    if (feed.quality) {
      const quality = asRecord(feed.quality);
      if (typeof quality.boostHighQuality === 'boolean') {
        patch.feedQualityBoostHighQuality = quality.boostHighQuality;
      }
      if (typeof quality.minEngagementRate === 'number') {
        patch.feedQualityMinEngagementRate = Math.max(0, Math.min(1, quality.minEngagementRate));
      } else if (quality.minEngagementRate === null) {
        patch.feedQualityMinEngagementRate = null;
      }
    }
  }

  return patch;
}

/**
 * PUT /api/profile/settings
 * Update current user's settings
 */
router.put('/settings', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const doc = await updateUserSettings(oxyUserId, buildSettingsPatch(asRecord(req.body)));

    return sendSuccessResponse(res, 200, doc);
  } catch (err) {
    logger.error('[ProfileSettings] Error updating settings:', describeErrorSafely(err));
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to update settings');
  }
});

/**
 * DELETE /api/profile/settings/behavior
 * Reset user behavior/preferences
 */
router.delete('/settings/behavior', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const deleted = await deleteUserBehavior(oxyUserId);

    return sendSuccessResponse(
      res,
      200,
      { success: true },
      deleted ? 'Personalization data reset successfully' : 'No personalization data to reset'
    );
  } catch (err) {
    logger.error('[ProfileSettings] Error resetting user behavior:', describeErrorSafely(err));
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to reset personalization data');
  }
});

export default router;
