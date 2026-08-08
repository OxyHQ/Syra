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
 * ## Two reads, because one route serves other people's rows
 *
 * `privacy.hiddenWords` and `privacy.restrictedUsers` are one person's muted
 * words and the accounts they have restricted. Both are registered in
 * `schema/protectedColumns.ts`, so `findImplicitWholeRowReads` refuses a bare
 * `db.select().from(userSettings)` and every read here has to name its columns.
 *
 *  - {@link ensureOwnUserSettings} — `GET /api/profile/settings/me`, where the
 *    caller IS the subject and reads back the whole document, both lists
 *    included.
 *  - {@link ensureViewerVisiblePrivacy} — `GET /api/profile/settings/:userId`,
 *    which any authenticated caller may ask for ANY account, and which returns
 *    NOTHING BUT the nine viewer-visible privacy flags.
 *
 * That second route served the whole document to any caller under Mongoose, and
 * not through an oversight a reviewer would spot: `ensureUserSettings` narrowed
 * the TypeScript type with `.lean<UserSettingsLean>()` and never projected, so
 * the type said four fields while the object carried all of them. The type was
 * the guard and a type is not one. `utils/userSettings.ts` also held an
 * `extractPublicProfileData` that WOULD have projected them out; it had no
 * callers anywhere in `packages/`, and is deleted rather than ported.
 *
 * ## Why an ALLOWLIST of nine, rather than the document minus two
 *
 * This module first shipped the narrower-looking fix — the full document with
 * the two protected columns withheld — and that is not tight enough. PR #85
 * fixed the same defect on `main` in parallel with a nine-field allowlist, and
 * reconciling the two settled it in that direction on the evidence rather than
 * on which landed first:
 *
 * `GET /api/profile/settings/:userId` has exactly ONE caller in the whole
 * repo — `frontend/hooks/usePrivacySettings.ts:75`, via `useProfileData` — and
 * it parses `{ privacy }` and reads nothing else. Everything else in the
 * document (`feedSettings`, `interests.tags`, `profileCustomization`,
 * `profileHeaderImage`) was therefore being served to arbitrary authenticated
 * callers for no consumer at all. The other two reads go to `/settings/me`,
 * which is unaffected.
 *
 * An allowlist is also the shape that survives the next field: a denylist keyed
 * on the protected-columns registry admits whatever is added to the table
 * tomorrow, which is the same reasoning `AGENTS.md` gives for hand-written DTOs
 * naming every key they return.
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

/**
 * Every column NOT registered as protected.
 *
 * No longer a route projection — it is one half of the owner read below. The
 * viewer read is {@link VIEWER_PRIVACY_COLUMNS}, an allowlist of nine.
 */
const UNPROTECTED_SETTINGS_COLUMNS = publicColumns(userSettings, PROTECTED_COLUMNS_BY_TABLE);

/**
 * The privacy fields a VIEWER legitimately needs to render someone else's
 * profile: visibility, and the flags describing how that profile presents to
 * other people. Everything else in the row belongs to its owner alone.
 *
 * Exported so a test can assert the LIST rather than only the function — adding
 * `hiddenWords` here would reintroduce the leak with every behavioural test
 * still green.
 */
export const VIEWER_VISIBLE_PRIVACY_FIELDS = [
  'profileVisibility',
  'showContactInfo',
  'allowTags',
  'allowMentions',
  'showOnlineStatus',
  'hideLikeCounts',
  'hideShareCounts',
  'hideReplyCounts',
  'hideSaveCounts',
] as const;

/** The nine columns behind {@link VIEWER_VISIBLE_PRIVACY_FIELDS}. */
const VIEWER_PRIVACY_COLUMNS = {
  profileVisibility: userSettings.privacyProfileVisibility,
  showContactInfo: userSettings.privacyShowContactInfo,
  allowTags: userSettings.privacyAllowTags,
  allowMentions: userSettings.privacyAllowMentions,
  showOnlineStatus: userSettings.privacyShowOnlineStatus,
  hideLikeCounts: userSettings.privacyHideLikeCounts,
  hideShareCounts: userSettings.privacyHideShareCounts,
  hideReplyCounts: userSettings.privacyHideReplyCounts,
  hideSaveCounts: userSettings.privacyHideSaveCounts,
} as const;

/**
 * What `GET /api/profile/settings/:userId` returns under `privacy`.
 *
 * Derived from the allowlist rather than written out, so the type cannot name a
 * field the query does not select — or fail to name one it does.
 */
export type ViewerVisiblePrivacy = Pick<
  UserSettingsPrivacy,
  (typeof VIEWER_VISIBLE_PRIVACY_FIELDS)[number]
>;

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
  ...UNPROTECTED_SETTINGS_COLUMNS,
  ...PRIVATE_SETTINGS_COLUMNS,
} as const;

type SettingsRow = typeof userSettings.$inferSelect;

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
  /**
   * The mute list and the restricted-account list. Present on the OWNER
   * document only; the viewer route returns {@link ViewerVisiblePrivacy}, which
   * cannot name them.
   */
  hiddenWords?: string[];
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
function toUserSettingsDto(row: SettingsRow): UserSettingsDto {
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

  // Only the OWNER projection reaches this function, so both lists are always
  // present. The viewer path does not build a `UserSettingsDto` at all — it
  // returns nine columns and never touches the rest of the row.
  privacy.hiddenWords = row.privacyHiddenWords;
  privacy.restrictedUsers = row.privacyRestrictedUsers;

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
 * What an account with no settings row presents as.
 *
 * A COPY of the nine columns' defaults, which is a second source of truth and
 * would normally be the wrong trade. It is safe here only because
 * `__tests__/settings.test.ts` pins it to the database: that test inserts a bare
 * row, reads it back through the real projection, and asserts it equals this
 * object. Change a default in `schema/user.ts` without changing this and the
 * test fails naming the field.
 */
const VIEWER_PRIVACY_DEFAULTS: ViewerVisiblePrivacy = {
  profileVisibility: 'public',
  showContactInfo: true,
  allowTags: true,
  allowMentions: true,
  showOnlineStatus: true,
  hideLikeCounts: false,
  hideShareCounts: false,
  hideReplyCounts: false,
  hideSaveCounts: false,
};

/**
 * Another account's VIEWER-VISIBLE privacy flags, and nothing else.
 *
 * Not "the document minus two fields" — the nine columns of
 * {@link VIEWER_VISIBLE_PRIVACY_FIELDS}, named. See this file's doc comment for
 * why the allowlist is the shape that survives the next column added to this
 * table, and for the single caller that decided the field set.
 *
 * ## It does NOT create a row, and the Mongo version did
 *
 * This route answers for ANY account id an authenticated caller cares to name,
 * so `ensureUserSettings`' find-or-create made a GET into an unbounded write
 * that any caller could drive: one `user_settings` row per id anyone ever asked
 * about, keyed by a string they chose. Faithful to Mongo, and not worth keeping
 * once the read needs nothing the row provides.
 *
 * An absent row and a default row are indistinguishable through this projection
 * — all nine columns are `notNull()` with defaults — so returning
 * {@link VIEWER_PRIVACY_DEFAULTS} gives the caller the same answer the insert
 * would have produced, without the write. `/settings/me` still creates, because
 * there the caller IS the subject and the row is theirs to have.
 */
export async function ensureViewerVisiblePrivacy(
  oxyUserId: string,
): Promise<ViewerVisiblePrivacy> {
  return (await selectViewerPrivacy(oxyUserId)) ?? { ...VIEWER_PRIVACY_DEFAULTS };
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

async function selectViewerPrivacy(
  oxyUserId: string,
  db: DbOrTransaction = getDb(),
): Promise<ViewerVisiblePrivacy | undefined> {
  const [row] = await db
    .select(VIEWER_PRIVACY_COLUMNS)
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
