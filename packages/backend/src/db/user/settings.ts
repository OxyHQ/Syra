/**
 * `user_settings` — one row per Oxy account, on drizzle.
 *
 * `models/UserSettings.ts` held five subdocuments (`appearance`, `privacy`,
 * `profileCustomization`, `interests`, `feedSettings`, the last with three inner
 * groups) that `schema/user.ts` flattened onto 26 columns. This module owns both
 * directions of that flattening: {@link toUserSettingsDto} re-nests a row into
 * the document shape the API has always returned, and {@link updateUserSettings}
 * takes a nested patch apart into columns.
 *
 * ## Two projections, because one route serves other people's rows
 *
 * `privacy.hiddenWords` and `privacy.restrictedUsers` are one person's muted
 * words and the accounts they have restricted. Both are registered in
 * `schema/protectedColumns.ts`, so `findImplicitWholeRowReads` refuses a bare
 * `db.select().from(userSettings)` and every read here has to name its columns.
 *
 * They are named in exactly one of the two:
 *
 *  - {@link OWN_SETTINGS_COLUMNS} — `GET /api/profile/settings/me`, where the
 *    caller IS the subject and reads back what they themselves muted.
 *  - {@link PUBLIC_SETTINGS_COLUMNS} — `GET /api/profile/settings/:userId`,
 *    which any authenticated caller may ask for ANY account.
 *
 * That second route served both lists to any caller under Mongoose, and not
 * through an oversight that a reviewer would spot: `ensureUserSettings` narrowed
 * the TypeScript type with `.lean<UserSettingsLean>()` and never projected, so
 * the type said four fields while the object carried all of them. The type was
 * the guard and a type is not one. `utils/userSettings.ts` also held an
 * `extractPublicProfileData` that WOULD have projected them out; it had no
 * callers anywhere in `packages/`, and is deleted rather than ported.
 *
 * Splitting the projection is the whole fix, and it costs nothing on the wire:
 * the only schema that names either field is `frontend/hooks/usePrivacySettings.ts`,
 * where both are `.optional()`, and no component reads them.
 *
 * ## Every group is now always present
 *
 * A genuine difference from Mongo, deliberately taken. `profileCustomization`,
 * `interests` and `feedSettings` had no Mongoose default, so they were ABSENT
 * from the document until something wrote them; every Postgres column is
 * `notNull().default(...)`, so the nested groups always render. The values are
 * the same defaults Mongoose would have applied on first write, and every
 * frontend reader is optional-chained, so this widens the response rather than
 * changing it. `ensureUserSettings`' backfill of a missing `profileCustomization`
 * has nothing left to do and is gone with it.
 */

import { eq } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import { getDb, type DbOrTransaction } from '../postgres';
import { PROTECTED_COLUMNS_BY_TABLE } from '../schema/protectedColumns';
import {
  PROFILE_VISIBILITIES,
  THEME_MODES,
  userSettings,
} from '../schema/user';

export type ThemeMode = (typeof THEME_MODES)[number];
export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number];

/** Every `user_settings` column a caller who is not the subject may see. */
export const PUBLIC_SETTINGS_COLUMNS = publicColumns(userSettings, PROTECTED_COLUMNS_BY_TABLE);

/**
 * The two server-only lists, named explicitly.
 *
 * Naming them is what `PROTECTED_COLUMNS_BY_TABLE` buys: this object is the only
 * place in the codebase either column appears in a read, so `grep` finds every
 * path that can put them on the wire.
 */
const PRIVATE_SETTINGS_COLUMNS = {
  privacyHiddenWords: userSettings.privacyHiddenWords,
  privacyRestrictedUsers: userSettings.privacyRestrictedUsers,
} as const;

/** Every column — the projection for a caller reading their OWN settings. */
const OWN_SETTINGS_COLUMNS = {
  ...PUBLIC_SETTINGS_COLUMNS,
  ...PRIVATE_SETTINGS_COLUMNS,
} as const;

type SettingsRow = typeof userSettings.$inferSelect;
type PublicSettingsRow = {
  -readonly [K in keyof typeof PUBLIC_SETTINGS_COLUMNS]: SettingsRow[K];
};

// ── The document shape the API returns ────────────────────────────────────

export interface UserSettingsAppearance {
  themeMode: ThemeMode;
  primaryColor?: string;
}

export interface UserSettingsPrivacy {
  profileVisibility: ProfileVisibility;
  showContactInfo: boolean;
  allowTags: boolean;
  allowMentions: boolean;
  showOnlineStatus: boolean;
  hideLikeCounts: boolean;
  hideShareCounts: boolean;
  hideReplyCounts: boolean;
  hideSaveCounts: boolean;
  /** Present only when the caller is the subject — see this file's doc comment. */
  hiddenWords?: string[];
  /** Present only when the caller is the subject. */
  restrictedUsers?: string[];
}

export interface UserSettingsProfileCustomization {
  coverPhotoEnabled: boolean;
  minimalistMode: boolean;
  displayName?: string;
  coverImage?: string;
}

export interface UserSettingsFeed {
  diversity: {
    enabled: boolean;
    sameAuthorPenalty: number;
    sameTopicPenalty: number;
    maxConsecutiveSameAuthor?: number;
  };
  recency: { halfLifeHours: number; maxAgeHours: number };
  quality: { minEngagementRate?: number; boostHighQuality: boolean };
}

export interface UserSettingsDto {
  oxyUserId: string;
  appearance: UserSettingsAppearance;
  profileHeaderImage?: string;
  privacy: UserSettingsPrivacy;
  profileCustomization: UserSettingsProfileCustomization;
  interests: { tags: string[] };
  feedSettings: UserSettingsFeed;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A nullable column as the document rendered it: absent, not `null`.
 *
 * Mongoose stored these as missing keys (`default: undefined`), and
 * `JSON.stringify` drops an `undefined` value, so mapping null to undefined is
 * what keeps the serialized response byte-identical to the Mongo one.
 */
function optional<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

/** Re-nest a flat row into the document shape every caller of this API expects. */
function toUserSettingsDto(row: PublicSettingsRow | SettingsRow): UserSettingsDto {
  const privacy: UserSettingsPrivacy = {
    profileVisibility: row.privacyProfileVisibility,
    showContactInfo: row.privacyShowContactInfo,
    allowTags: row.privacyAllowTags,
    allowMentions: row.privacyAllowMentions,
    showOnlineStatus: row.privacyShowOnlineStatus,
    hideLikeCounts: row.privacyHideLikeCounts,
    hideShareCounts: row.privacyHideShareCounts,
    hideReplyCounts: row.privacyHideReplyCounts,
    hideSaveCounts: row.privacyHideSaveCounts,
  };

  // Present only on the owner projection, which is the only one that selects
  // them; `in` distinguishes that from a row that merely has them empty.
  if ('privacyHiddenWords' in row) {
    privacy.hiddenWords = row.privacyHiddenWords;
    privacy.restrictedUsers = row.privacyRestrictedUsers;
  }

  return {
    oxyUserId: row.oxyUserId,
    appearance: {
      themeMode: row.appearanceThemeMode,
      primaryColor: optional(row.appearancePrimaryColor),
    },
    profileHeaderImage: optional(row.profileHeaderImage),
    privacy,
    profileCustomization: {
      coverPhotoEnabled: row.profileCustomizationCoverPhotoEnabled,
      minimalistMode: row.profileCustomizationMinimalistMode,
      displayName: optional(row.profileCustomizationDisplayName),
      coverImage: optional(row.profileCustomizationCoverImage),
    },
    interests: { tags: row.interestsTags },
    feedSettings: {
      diversity: {
        enabled: row.feedDiversityEnabled,
        sameAuthorPenalty: row.feedDiversitySameAuthorPenalty,
        sameTopicPenalty: row.feedDiversitySameTopicPenalty,
        maxConsecutiveSameAuthor: optional(row.feedDiversityMaxConsecutiveSameAuthor),
      },
      recency: {
        halfLifeHours: row.feedRecencyHalfLifeHours,
        maxAgeHours: row.feedRecencyMaxAgeHours,
      },
      quality: {
        minEngagementRate: optional(row.feedQualityMinEngagementRate),
        boostHighQuality: row.feedQualityBoostHighQuality,
      },
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────

/**
 * The caller's own settings, creating the row on first read.
 *
 * `insert … on conflict do nothing … returning` would return NOTHING on the
 * conflict path, so the row is read first and inserted only when absent; the
 * insert then tolerates a concurrent creator and re-reads. Every column has a
 * default, so the insert names only `oxyUserId`.
 */
export async function ensureOwnUserSettings(oxyUserId: string): Promise<UserSettingsDto> {
  const existing = await selectOwnRow(oxyUserId);
  if (existing) return toUserSettingsDto(existing);

  await getDb().insert(userSettings).values({ oxyUserId }).onConflictDoNothing();

  const created = await selectOwnRow(oxyUserId);
  if (!created) {
    throw new Error(`user_settings row for ${oxyUserId} vanished between insert and read`);
  }
  return toUserSettingsDto(created);
}

/**
 * Another account's settings, with the two server-only lists withheld.
 *
 * Creates the row for the same reason the Mongo version did: the route answers
 * for any account id, and a caller asking about someone with no row gets the
 * defaults rather than a 404.
 */
export async function ensurePublicUserSettings(oxyUserId: string): Promise<UserSettingsDto> {
  const existing = await selectPublicRow(oxyUserId);
  if (existing) return toUserSettingsDto(existing);

  await getDb().insert(userSettings).values({ oxyUserId }).onConflictDoNothing();

  const created = await selectPublicRow(oxyUserId);
  if (!created) {
    throw new Error(`user_settings row for ${oxyUserId} vanished between insert and read`);
  }
  return toUserSettingsDto(created);
}

async function selectOwnRow(
  oxyUserId: string,
  db: DbOrTransaction = getDb(),
): Promise<SettingsRow | undefined> {
  const [row] = await db
    .select(OWN_SETTINGS_COLUMNS)
    .from(userSettings)
    .where(eq(userSettings.oxyUserId, oxyUserId))
    .limit(1);
  return row;
}

async function selectPublicRow(
  oxyUserId: string,
  db: DbOrTransaction = getDb(),
): Promise<PublicSettingsRow | undefined> {
  const [row] = await db
    .select(PUBLIC_SETTINGS_COLUMNS)
    .from(userSettings)
    .where(eq(userSettings.oxyUserId, oxyUserId))
    .limit(1);
  return row;
}

// ── Write ─────────────────────────────────────────────────────────────────

/**
 * The patch {@link updateUserSettings} accepts — already validated and clamped
 * by the route, one property per column.
 *
 * `null` means CLEAR and `undefined` means LEAVE ALONE, which is the distinction
 * the Mongo version could not express. See {@link updateUserSettings}.
 */
export interface UserSettingsPatch {
  appearanceThemeMode?: ThemeMode;
  appearancePrimaryColor?: string | null;
  profileHeaderImage?: string;
  privacyProfileVisibility?: ProfileVisibility;
  privacyShowContactInfo?: boolean;
  privacyAllowTags?: boolean;
  privacyAllowMentions?: boolean;
  privacyShowOnlineStatus?: boolean;
  privacyHideLikeCounts?: boolean;
  privacyHideShareCounts?: boolean;
  privacyHideReplyCounts?: boolean;
  privacyHideSaveCounts?: boolean;
  privacyHiddenWords?: string[];
  privacyRestrictedUsers?: string[];
  profileCustomizationCoverPhotoEnabled?: boolean;
  profileCustomizationMinimalistMode?: boolean;
  profileCustomizationDisplayName?: string | null;
  profileCustomizationCoverImage?: string | null;
  interestsTags?: string[];
  feedDiversityEnabled?: boolean;
  feedDiversitySameAuthorPenalty?: number;
  feedDiversitySameTopicPenalty?: number;
  feedDiversityMaxConsecutiveSameAuthor?: number | null;
  feedRecencyHalfLifeHours?: number;
  feedRecencyMaxAgeHours?: number;
  feedQualityMinEngagementRate?: number | null;
  feedQualityBoostHighQuality?: boolean;
}

/**
 * Apply a patch, creating the row when the caller has none.
 *
 * ## `null` clears, and under Mongoose nothing did
 *
 * The Mongo route expressed "clear this field" by assigning `undefined` into its
 * `$set` object, for five fields: `appearance.primaryColor`,
 * `profileCustomization.{displayName,coverImage}`,
 * `feedSettings.diversity.maxConsecutiveSameAuthor` and
 * `feedSettings.quality.minEngagementRate`. **Mongoose 9 strips undefined-valued
 * keys out of an update**, so all five branches were no-ops: the request
 * succeeded, the response echoed the unchanged document, and the field kept its
 * old value. Measured on 9.7.4 against a real mongod, with an explicit `null`
 * as the control to prove the probe could tell the two apart.
 *
 * So this is not a port of the old behaviour — it is the intent that behaviour
 * failed to implement, and clearing works here where it did not there. Recorded
 * as a deliberate difference rather than silently matched, because "the field
 * did not clear" is a defect however long it has been shipping.
 *
 * `buildUpdateSet` drops undefined-valued keys, which is why `null` is the
 * clearing value and why every clearable property above is typed `| null`.
 */
export async function updateUserSettings(
  oxyUserId: string,
  patch: UserSettingsPatch,
): Promise<UserSettingsDto> {
  await getDb()
    .insert(userSettings)
    .values({ oxyUserId, ...patch })
    .onConflictDoUpdate({
      target: userSettings.oxyUserId,
      set: { ...patch, updatedAt: new Date() },
    });

  const row = await selectOwnRow(oxyUserId);
  if (!row) {
    throw new Error(`user_settings row for ${oxyUserId} vanished between write and read`);
  }
  return toUserSettingsDto(row);
}
