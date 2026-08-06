/**
 * User, taste and listening schema — the per-account rows (`user_settings`,
 * `user_music_preferences`, `user_behavior`, `notification_preferences`), the
 * recommendation engine's learned state (`user_taste_profiles` and its two
 * children, `catalog_relations`), and the two tables Mongo reaped with a TTL
 * index (`listening_events`, `notification_suppressions`).
 *
 * Ported from `packages/backend/src/models/{UserSettings,UserMusicPreferences,
 * UserBehavior,UserTasteProfile,ListeningEvent,CatalogRelation,
 * NotificationPreference,NotificationSuppression}.ts`, field by field, against
 * `packages/backend/docs/db/RELATIONS.md` for every foreign key.
 *
 * ## The two TTL indexes — and why they are the whole point of this file
 *
 * `db/expiry.ts`'s registry is the Postgres replacement for a Mongo TTL index,
 * and this vertical is where it stops being empty. Two of this repo's four
 * `expireAfterSeconds` declarations live here:
 *
 *  - `NotificationSuppression.expiresAt`, `expireAfterSeconds: 0` — the column
 *    IS the deadline, so `retentionSeconds: 0`.
 *  - `ListeningEvent.playedAt`, `expireAfterSeconds: 90 days` — a retention
 *    window measured from a birth column.
 *
 * (The other two, `ModerationOutbox` and `ModerationEvent`, are Task 8's. The
 * brief's prose says this task lands three of four; `grep -rn
 * "expireAfterSeconds" packages/backend/src` returns four declarations total
 * and two of them are here, which is also what the brief's own table says.
 * Raised in this task's report.)
 *
 * Each entry needs a supporting index or the sweep's `column <= now() - N`
 * predicate becomes a full table scan every time it runs — the exact cost the
 * Mongo TTL index hid. `listening_events_played_at_idx` and
 * `notification_suppressions_expires_at_idx` below are those indexes;
 * `findUnsupportedExpiryColumns` (`@oxyhq/db/assert`, driven from
 * `__tests__/gates.test.ts` against the real catalogue) fails the gate if
 * either goes away, and the planner probe in that file's Task 7 block proves
 * the index actually SERVES the sweep's own statement rather than merely
 * existing.
 *
 * ## The read that depends on a swept row already being gone
 *
 * `@oxyhq/db/expiry`'s own rule: a registry entry is only safe once the
 * table's readers are audited for depending on absence, because Mongo's TTL
 * monitor lags ~60s while a sweep lags one scheduled call. The two tables here
 * answer that question differently, and the difference matters:
 *
 *  - `listening_events` is safe. Every reader filters time itself —
 *    `coOccurrenceJob.ts:73-74` (`playedAt: { $gte: since }`, a 60-day lookback)
 *    and `recommendationService.ts:239` (`sort({ playedAt: -1 }).limit(200)`,
 *    a rolling view). A row the sweep has not reached yet is older than the
 *    lookback and is already excluded; nothing reads it.
 *  - `notification_suppressions` is NOT, and this is a real (small) behaviour
 *    change the port must carry deliberately. `claimSuppression`
 *    (`services/notifications/notifier.ts:133`) INSERTS and treats the
 *    duplicate-key error as "already notified" — it never reads `expiresAt` at
 *    all, so a row that has expired but has not been swept keeps suppressing.
 *    Under Mongo that overshoot was bounded by the TTL monitor's ~60s;
 *    under a sweep on the 30-minute tick `services/recommendations/
 *    scheduler.ts` already uses, it is bounded by 30 minutes — against a
 *    6-hour default coalescing window (`notifier.ts:31`), up to ~8% late
 *    rather than ~0.3%. THE FIX BELONGS IN THE PORT OF THAT WRITE PATH, not
 *    here: `insert ... on conflict (oxy_user_id, key) do update set expires_at
 *    = excluded.expires_at where notification_suppressions.expires_at <=
 *    now()` claims an expired row instead of colliding with it, which makes
 *    the sweep pure housekeeping and the window exact. The unique constraint
 *    below is what makes that `on conflict` expressible; whoever ports
 *    `notifier.ts` owes the rest.
 *
 * ## `UserBehavior` is built, and nothing has ever written to it
 *
 * `grep -rln "UserBehavior" packages/backend/src` returns exactly two files:
 * its own model, and `routes/profileSettings.ts:213`, where the only use is
 * `UserBehavior.findOneAndDelete({ oxyUserId })` in the account-deletion
 * cleanup. No route, service or script ever creates or updates one. RELATIONS.md
 * reaches the same conclusion independently and RECOMMENDS DROPPING THE WHOLE
 * MODEL; the brief's `Produces` list names it, so it is built here and the
 * disagreement is raised in this task's report rather than settled quietly in
 * either direction. It is the cheapest thing in this schema to drop later —
 * one table, no foreign keys pointing at it, and no rows.
 *
 * ## Which arrays became child tables, and which stayed arrays
 *
 * `schema/creators.ts` settled the discriminator this schema had split two
 * ways: an array of OBJECTS with a known, shared sub-schema becomes a child
 * table when LIVE CODE WRITES IT, and stays `jsonb` when nothing does.
 *
 * `UserTasteProfile.genres[]` and `.artists[]` are both — the same
 * `TasteWeightSchema` (`models/UserTasteProfile.ts:39`) declared once and used
 * twice, written on every play (`recordPlay.ts:188-189`), every like and every
 * follow (`tasteSignals.ts:70-71,92-94`), and rewritten wholesale by the decay
 * pass (`tasteDecay.ts:53-58`). So both become child tables:
 * `user_taste_genres` and `user_taste_artists`.
 *
 * TWO tables rather than one with a `kind` discriminator, because the two
 * arrays do not hold the same thing. RELATIONS.md is explicit: `artists[].key`
 * is a real `catalog_entities` id while `genres[].key` is a lowercase genre
 * string that is NOT a row id — "same field name, two different meanings
 * depending on which array it sits in". Splitting them is what lets the artist
 * side carry a real foreign key (CASCADE, matching
 * `listening_events.artist_id`: both are disposable learned signal, and the
 * durable artifacts are recomputed) while the genre side stays plain text.
 *
 * Neither child gets a `position`. `position` exists on this schema's other
 * child tables to preserve a Mongo array's ORDER; these two arrays have none
 * worth preserving — every reader sorts by `weight` and the writers re-sort in
 * place when trimming to `MAX_TASTE_GENRES`/`MAX_TASTE_ARTISTS`. What IS an
 * invariant is one row per key, which `applyWeight` (`recordPlay.ts:208`) held
 * in memory with a `list.find(...)` and a `unique(taste_profile_id, <key>)`
 * now holds for real.
 *
 * Everything else stays an array of scalars, read whole and never queried by
 * element — `UserSettings.privacy.{hiddenWords,restrictedUsers}`,
 * `.interests.tags`, `UserBehavior.{preferredAuthors,preferredTopics,
 * preferredLanguages,activeHours}`, `NotificationPreference.disabledEvents`.
 * Same `text[]`/`integer[]` treatment `library.ts` gives `PlaybackState.queue`.
 * The two element-level enums Mongoose declared (`disabledEvents`,
 * `activeHours`) keep their validation as a `<@` containment CHECK against the
 * same tuple that types the column, which is how an array column keeps a
 * per-element constraint at all.
 *
 * ## Which subdocuments were flattened
 *
 * `UserSettings.{appearance,privacy,profileCustomization,interests,
 * feedSettings}` are single subdocuments, not arrays, so each flattens onto
 * the parent row — the treatment `rooms.ts` gives `Series.recurrence` and
 * `catalog.ts` gives `Track.audioSource`. `feedSettings`' three inner groups
 * flatten one level further (`feed_diversity_*`, `feed_recency_*`,
 * `feed_quality_*`), dropping the redundant `settings_` infix: the full
 * `feed_settings_diversity_max_consecutive_same_author` would be a 51-byte
 * column whose CHECK name (`user_settings_…_check`) lands at 71 bytes, past
 * the 63 Postgres silently truncates at.
 *
 * A field with a Mongoose DEFAULT becomes `notNull().default(...)`; a field
 * without one stays nullable. That is the whole rule, and it is why
 * `feed_diversity_max_consecutive_same_author` and
 * `feed_quality_min_engagement_rate` are the two nullable numbers in an
 * otherwise fully-defaulted block.
 *
 * ## `profile_header_image` / `profile_customization_cover_image` are URLs
 *
 * Neither is an `image_assets` reference, unlike the seven models that carry
 * `coverArt`/`image`. RELATIONS.md checked this specifically: these two go
 * through "a different, non-`ImageAsset` path — a raw S3 CDN URL string...
 * stored verbatim with no `ObjectId` validation at all"
 * (`routes/profileSettings.ts:97-100`). Plain `text`, no foreign key, and
 * their names do not end in `_id` so no ledger entry either.
 *
 * ## `catalog_relations` carries no `created_at`/`updated_at`
 *
 * Alone in this schema, because `models/CatalogRelation.ts:41` sets
 * `timestamps: false`. The table is a fully regenerable cache — the
 * co-occurrence job `deleteMany({ kind })`s and rewrites the whole graph each
 * pass (`coOccurrenceJob.ts:205`) — and `computed_at` already records the only
 * instant anything cares about. Its two id columns get no foreign key at all,
 * per RELATIONS.md: they are polymorphic by `kind` (a `tracks` id under
 * `kind = 'track'`, a `catalog_entities` id under `kind = 'artist'`), and
 * Postgres has no conditional foreign key.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, doublePrecision, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import {
  createdAt,
  generatedId,
  inList,
  numericInList,
  textArrayLiteral,
  timestamptz,
  updatedAt,
} from '@oxyhq/db';
import { catalogEntities, tracks } from './catalog';

// ── Closed value sets ────────────────────────────────────────────────────
// Same convention as catalog.ts: one `as const` tuple per closed value set,
// used both to type the column and to derive its CHECK.

/** `models/UserSettings.ts:65` `ThemeMode`. */
export const THEME_MODES = ['light', 'dark', 'system'] as const;

/** `models/UserSettings.ts:70` `PrivacySettings.profileVisibility`. */
export const PROFILE_VISIBILITIES = ['public', 'private', 'followers_only'] as const;

/** `@syra/shared-types` `audioQualitySchema`. */
export const AUDIO_QUALITIES = ['low', 'normal', 'high', 'very_high'] as const;

/** `models/ListeningEvent.ts:58` `LISTENING_SOURCES`. */
export const LISTENING_SOURCES = [
  'search',
  'library',
  'playlist',
  'album',
  'artist',
  'radio',
  'recommendation',
  'charts',
  'queue',
  'unknown',
] as const;

/** `models/CatalogRelation.ts:4` `RelationKind` — which id space `source_id`/`target_id` are in. */
export const CATALOG_RELATION_KINDS = ['track', 'artist'] as const;

/**
 * `models/NotificationPreference.ts:11` `SYRA_NOTIFICATION_EVENTS` — Syra's own
 * event taxonomy, beneath Oxy's channel-level push switch. Stored as an
 * opt-OUT list, so a user with no row has every event enabled and a new event
 * type needs no backfill.
 */
export const SYRA_NOTIFICATION_EVENTS = [
  'episode.published',
  'artist.release',
  'room.started',
  'playlist.collaboration',
  'upload.expiring',
  'upload.removed',
] as const;

/**
 * `models/UserBehavior.ts:38`'s per-element `min: 0, max: 23`.
 *
 * A literal set rather than a range test: an element-wise bound on an array
 * column needs `unnest`, and a CHECK constraint may not contain a subquery, so
 * `<@` containment against the enumerated hours is the only expressible form.
 * Built from a range rather than typed out so the tuple and the constraint
 * cannot disagree — `numericInList` renders it deterministically, which is what
 * keeps the emitted DDL byte-stable across `db:generate` runs.
 */
const ACTIVE_HOURS = Array.from({ length: 24 }, (_, hour) => hour);

// ── user_settings ─────────────────────────────────────────────────────────

export const userSettings = pgTable(
  'user_settings',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. One row per account. */
    oxyUserId: text().notNull(),
    appearanceThemeMode: text({ enum: THEME_MODES }).notNull().default('system'),
    /** `default: undefined` in Mongoose — absent, never an empty string. */
    appearancePrimaryColor: text(),
    /** A raw CDN URL, not an `image_assets` id — see the file-level doc comment. */
    profileHeaderImage: text(),
    privacyProfileVisibility: text({ enum: PROFILE_VISIBILITIES }).notNull().default('public'),
    privacyShowContactInfo: boolean().notNull().default(true),
    privacyAllowTags: boolean().notNull().default(true),
    privacyAllowMentions: boolean().notNull().default(true),
    privacyShowOnlineStatus: boolean().notNull().default(true),
    privacyHideLikeCounts: boolean().notNull().default(false),
    privacyHideShareCounts: boolean().notNull().default(false),
    privacyHideReplyCounts: boolean().notNull().default(false),
    privacyHideSaveCounts: boolean().notNull().default(false),
    /**
     * Words this person has muted. Server-only — registered in
     * `protectedColumns.ts` alongside `privacyRestrictedUsers`; see that
     * registry and `__tests__/gates.test.ts`'s Task 7 block for the route that
     * serves both to any caller today.
     */
    privacyHiddenWords: text().array().notNull().default(sql`array[]::text[]`),
    /** Oxy account ids this person has restricted. Server-only, same as above. */
    privacyRestrictedUsers: text().array().notNull().default(sql`array[]::text[]`),
    profileCustomizationCoverPhotoEnabled: boolean().notNull().default(true),
    profileCustomizationMinimalistMode: boolean().notNull().default(false),
    profileCustomizationDisplayName: text(),
    /** A raw CDN URL, not an `image_assets` id — see the file-level doc comment. */
    profileCustomizationCoverImage: text(),
    interestsTags: text().array().notNull().default(sql`array[]::text[]`),
    feedDiversityEnabled: boolean().notNull().default(true),
    feedDiversitySameAuthorPenalty: doublePrecision().notNull().default(0.95),
    feedDiversitySameTopicPenalty: doublePrecision().notNull().default(0.92),
    /** No Mongoose default (`models/UserSettings.ts:99`) — nullable. Rounded by its writer, so `integer`. */
    feedDiversityMaxConsecutiveSameAuthor: integer(),
    /**
     * `doublePrecision`, not `integer`: `routes/profileSettings.ts:170` clamps
     * without rounding, so a fractional half-life is a value the live API
     * already accepts.
     */
    feedRecencyHalfLifeHours: doublePrecision().notNull().default(24),
    feedRecencyMaxAgeHours: doublePrecision().notNull().default(168),
    /** No Mongoose default (`models/UserSettings.ts:106`) — nullable. */
    feedQualityMinEngagementRate: doublePrecision(),
    feedQualityBoostHighQuality: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'user_settings_theme_mode_check',
      sql`${t.appearanceThemeMode} in (${sql.raw(inList(THEME_MODES))})`
    ),
    check(
      'user_settings_profile_visibility_check',
      sql`${t.privacyProfileVisibility} in (${sql.raw(inList(PROFILE_VISIBILITIES))})`
    ),
    // The five bounded feed numbers (`models/UserSettings.ts:97-107`). Mongoose
    // enforces each on every save, so a port that dropped them would silently
    // loosen validation — the same reasoning `rooms.ts` applied to its eleven
    // `maxlength`/`match` declarations.
    check(
      'user_settings_feed_diversity_same_author_penalty_check',
      sql`${t.feedDiversitySameAuthorPenalty} between 0.5 and 1.0`
    ),
    check(
      'user_settings_feed_diversity_same_topic_penalty_check',
      sql`${t.feedDiversitySameTopicPenalty} between 0.5 and 1.0`
    ),
    check(
      'user_settings_feed_diversity_max_consecutive_check',
      sql`${t.feedDiversityMaxConsecutiveSameAuthor} is null or ${t.feedDiversityMaxConsecutiveSameAuthor} between 1 and 10`
    ),
    check(
      'user_settings_feed_recency_half_life_hours_check',
      sql`${t.feedRecencyHalfLifeHours} between 6 and 72`
    ),
    check(
      'user_settings_feed_recency_max_age_hours_check',
      sql`${t.feedRecencyMaxAgeHours} between 24 and 336`
    ),
    check(
      'user_settings_feed_quality_min_engagement_rate_check',
      sql`${t.feedQualityMinEngagementRate} is null or ${t.feedQualityMinEngagementRate} between 0 and 1`
    ),
    // One row per account: every reader is a `findOne({ oxyUserId })`
    // (`utils/userSettings.ts:21`), and the unique index is what makes that
    // deterministic. Its leading column also serves the plain lookup, so no
    // separate index is added — an index dropped in writing, per Task 2's
    // convention.
    unique('user_settings_oxy_user_id_key').on(t.oxyUserId),
  ]
);

// ── user_music_preferences ────────────────────────────────────────────────

export const userMusicPreferences = pgTable(
  'user_music_preferences',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. One row per account. */
    oxyUserId: text().notNull(),
    defaultVolume: doublePrecision().notNull().default(0.7),
    autoplay: boolean().notNull().default(true),
    /** Seconds; `0` disables. `doublePrecision` for the same reason as the feed hours above. */
    crossfade: doublePrecision().notNull().default(0),
    gaplessPlayback: boolean().notNull().default(true),
    normalizeVolume: boolean().notNull().default(true),
    explicitContent: boolean().notNull().default(true),
    audioQuality: text({ enum: AUDIO_QUALITIES }).notNull().default('normal'),
    downloadQuality: text({ enum: AUDIO_QUALITIES }).notNull().default('normal'),
    dataSaver: boolean().notNull().default(false),
    monoAudio: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('user_music_preferences_default_volume_check', sql`${t.defaultVolume} between 0 and 1`),
    check('user_music_preferences_crossfade_check', sql`${t.crossfade} between 0 and 12`),
    check(
      'user_music_preferences_audio_quality_check',
      sql`${t.audioQuality} in (${sql.raw(inList(AUDIO_QUALITIES))})`
    ),
    check(
      'user_music_preferences_download_quality_check',
      sql`${t.downloadQuality} in (${sql.raw(inList(AUDIO_QUALITIES))})`
    ),
    unique('user_music_preferences_oxy_user_id_key').on(t.oxyUserId),
  ]
);

// ── user_behavior (declared, never written — see the file-level doc comment) ──

export const userBehavior = pgTable(
  'user_behavior',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. One row per account. */
    oxyUserId: text().notNull(),
    /** Oxy account ids. Not `*_id`-suffixed, and nothing has ever written one. */
    preferredAuthors: text().array().notNull().default(sql`array[]::text[]`),
    preferredTopics: text().array().notNull().default(sql`array[]::text[]`),
    preferredPostTypesText: integer().notNull().default(0),
    preferredPostTypesImage: integer().notNull().default(0),
    preferredPostTypesVideo: integer().notNull().default(0),
    preferredPostTypesPoll: integer().notNull().default(0),
    /** Hours of the day (0-23) this account is most active. */
    activeHours: integer().array().notNull().default(sql`array[]::integer[]`),
    preferredLanguages: text().array().notNull().default(sql`array[]::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'user_behavior_active_hours_check',
      sql`${t.activeHours} <@ array[${sql.raw(numericInList(ACTIVE_HOURS))}]::integer[]`
    ),
    unique('user_behavior_oxy_user_id_key').on(t.oxyUserId),
  ]
);

// ── user_taste_profiles + its two weight children ─────────────────────────

export const userTasteProfiles = pgTable(
  'user_taste_profiles',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. One row per account. */
    oxyUserId: text().notNull(),
    /** Total weighted engagement observed — a maturity signal for cold-start. */
    totalSignal: doublePrecision().notNull().default(0),
    /**
     * When global decay was last applied. `tasteDecay.ts:45-49` reads it to
     * apply time-PROPORTIONAL decay, which is what makes the pass idempotent
     * and independent of how often the scheduler runs.
     */
    lastDecayAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('user_taste_profiles_total_signal_check', sql`${t.totalSignal} >= 0`),
    unique('user_taste_profiles_oxy_user_id_key').on(t.oxyUserId),
  ]
);

export const userTasteGenres = pgTable(
  'user_taste_genres',
  {
    id: generatedId(),
    tasteProfileId: text()
      .notNull()
      .references(() => userTasteProfiles.id, { onDelete: 'cascade' }),
    /**
     * A lowercase genre string (`"jazz"`), NOT a `genres.id` — RELATIONS.md
     * classifies it NOT-A-ROW-ID, and its writers derive it from a track's own
     * `genre`/`metadata.genre` text (`recordPlay.ts:107`), which has never been
     * required to match a catalogued genre row.
     */
    genre: text().notNull(),
    weight: doublePrecision().notNull().default(0),
  },
  (t) => [
    check('user_taste_genres_weight_check', sql`${t.weight} >= 0`),
    // One row per key per profile — the invariant `applyWeight`'s in-memory
    // `list.find(...)` held. Its leading column also serves "load this
    // profile's genres", so no separate index.
    unique('user_taste_genres_taste_profile_id_genre_key').on(t.tasteProfileId, t.genre),
  ]
);

export const userTasteArtists = pgTable(
  'user_taste_artists',
  {
    id: generatedId(),
    tasteProfileId: text()
      .notNull()
      .references(() => userTasteProfiles.id, { onDelete: 'cascade' }),
    /**
     * A real `catalog_entities` (artist) id, unlike its genre sibling —
     * RELATIONS.md draws exactly this distinction. CASCADE for the same reason
     * `listening_events.artist_id` cascades: a learned weight is disposable
     * signal, recomputed from events, and keeping one for an artist that no
     * longer exists only skews recommendations nobody can act on.
     */
    artistId: text()
      .notNull()
      .references(() => catalogEntities.id, { onDelete: 'cascade' }),
    weight: doublePrecision().notNull().default(0),
  },
  (t) => [
    check('user_taste_artists_weight_check', sql`${t.weight} >= 0`),
    unique('user_taste_artists_taste_profile_id_artist_id_key').on(t.tasteProfileId, t.artistId),
    /**
     * The CASCADE's own supporting index. The unique constraint above leads
     * with `taste_profile_id`, so it cannot serve the referential lookup
     * Postgres makes on THIS column when a `catalog_entities` row is deleted —
     * the same gap Task 6's review (I1) found on `rooms.house_id`, where a
     * partial listing index was mistaken for constraint support. Proved by the
     * planner probe in `__tests__/gates.test.ts`, not by this comment.
     */
    index('user_taste_artists_artist_id_idx').on(t.artistId),
  ]
);

// ── listening_events (TTL-bounded, 90-day retention) ──────────────────────

/**
 * `models/ListeningEvent.ts:72`'s `LISTENING_EVENT_TTL_SEC` — 90 days. Exported
 * so `db/expiry.ts`'s registry entry reads the SAME number this table's own
 * doc comment describes rather than a second copy that could drift from it.
 */
export const LISTENING_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export const listeningEvents = pgTable(
  'listening_events',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    trackId: text()
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    /**
     * The artist at play time. Not derivable from `track_id` after the fact —
     * a track's `artist_id` can be re-pointed by a later match — and the
     * co-occurrence miner reads it directly (`coOccurrenceJob.ts:112`).
     */
    artistId: text()
      .notNull()
      .references(() => catalogEntities.id, { onDelete: 'cascade' }),
    /** Lowercased primary genre at play time, if known. Not a `genres.id`. */
    genre: text(),
    /** Track length in seconds at play time (snapshot). */
    durationSec: doublePrecision(),
    listenedSec: doublePrecision().notNull().default(0),
    completion: doublePrecision().notNull().default(0),
    skipped: boolean().notNull().default(false),
    source: text({ enum: LISTENING_SOURCES }).notNull().default('unknown'),
    playedAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('listening_events_listened_sec_check', sql`${t.listenedSec} >= 0`),
    check('listening_events_completion_check', sql`${t.completion} between 0 and 1`),
    check('listening_events_source_check', sql`${t.source} in (${sql.raw(inList(LISTENING_SOURCES))})`),
    // Co-occurrence mining walks each user's events in time order
    // (`coOccurrenceJob.ts:79`, `sort({ oxyUserId: 1, playedAt: 1 })`). Its
    // leading column also serves `recommendationService.ts:239`'s
    // per-user newest-first read, so Mongo's standalone `{ oxyUserId: 1 }` is
    // dropped rather than ported.
    index('listening_events_oxy_user_id_played_at_idx').on(t.oxyUserId, t.playedAt),
    /**
     * THE SWEEP'S INDEX. `db/expiry.ts` registers `played_at` with a 90-day
     * retention, and `sweepExpiredRows` range-scans `played_at <= now() - 90d`
     * on every run; without a leading btree here that is a full scan of the
     * largest table in this schema, which is precisely the cost Mongo's TTL
     * index was paying invisibly. Ascending, which serves both the sweep's
     * range and Mongo's `{ playedAt: -1 }` popularity scan (a btree reads
     * backwards).
     */
    index('listening_events_played_at_idx').on(t.playedAt),
    /**
     * The two CASCADEs' supporting indexes. Both ported from Mongo's own
     * `index: true`, and both load-bearing for a different reason here: a
     * `tracks`/`catalog_entities` delete makes Postgres find every referencing
     * row, and this is the table designed to hold millions of them.
     */
    index('listening_events_track_id_idx').on(t.trackId),
    index('listening_events_artist_id_idx').on(t.artistId),
  ]
);

// ── catalog_relations (the precomputed recommendation graph) ──────────────

export const catalogRelations = pgTable(
  'catalog_relations',
  {
    id: generatedId(),
    /** Which id space `source_id`/`target_id` are in — see the file-level doc comment. */
    kind: text({ enum: CATALOG_RELATION_KINDS }).notNull(),
    sourceId: text().notNull(),
    targetId: text().notNull(),
    /** Normalised similarity in (0, 1]. */
    score: doublePrecision().notNull(),
    /** Raw co-occurrence count backing the score (debugging / ranking ties). */
    coCount: integer().notNull().default(0),
    computedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    check('catalog_relations_kind_check', sql`${t.kind} in (${sql.raw(inList(CATALOG_RELATION_KINDS))})`),
    check('catalog_relations_score_check', sql`${t.score} >= 0`),
    check('catalog_relations_co_count_check', sql`${t.coCount} >= 0`),
    // The primary read: top related entities for one source, best score first
    // (`recommendationService.ts:90,149`, `taste.ts:46`, `radioPools.ts:153`).
    // Its leading column also serves the job's `deleteMany({ kind })`.
    index('catalog_relations_kind_source_id_score_idx').on(t.kind, t.sourceId, t.score.desc()),
    // The upsert key: exactly one edge per (kind, source, target).
    unique('catalog_relations_kind_source_id_target_id_key').on(t.kind, t.sourceId, t.targetId),
  ]
);

// ── notification_preferences / notification_suppressions ──────────────────

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. One row per account. */
    oxyUserId: text().notNull(),
    /** Events this account has explicitly turned OFF. Absent from the list = enabled. */
    disabledEvents: text({ enum: SYRA_NOTIFICATION_EVENTS })
      .array()
      .notNull()
      .default(sql`array[]::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Mongoose validates the enum PER ELEMENT; `<@` containment is how an
    // array column keeps that. Trivially satisfied by the empty default.
    check(
      'notification_preferences_disabled_events_check',
      sql`${t.disabledEvents} <@ ${sql.raw(textArrayLiteral(SYRA_NOTIFICATION_EVENTS))}`
    ),
    unique('notification_preferences_oxy_user_id_key').on(t.oxyUserId),
  ]
);

export const notificationSuppressions = pgTable(
  'notification_suppressions',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    /**
     * Composite suppression key — `<event>:<entityId>` (exact) or
     * `<event>:group:<groupId>` (coalescing). RELATIONS.md classifies it
     * NOT-A-ROW-ID: a formatted string embedding an id that the notifier only
     * ever compares for equality, never parses back apart.
     */
    key: text().notNull(),
    /** THE DEADLINE ITSELF — `db/expiry.ts` registers this with `retentionSeconds: 0`. */
    expiresAt: timestamptz().notNull(),
    /** `timestamps: { createdAt: true, updatedAt: false }` — a claim is never updated. */
    createdAt: createdAt(),
  },
  (t) => [
    /**
     * THE DECISION, not hygiene: `claimSuppression` inserts and reads the
     * duplicate-key error as "already notified, skip". A read-then-write would
     * race two concurrent feed refreshes into both emitting. Also the conflict
     * target the expiry-aware upsert this table needs will use — see the
     * file-level doc comment.
     */
    unique('notification_suppressions_oxy_user_id_key_key').on(t.oxyUserId, t.key),
    /**
     * THE SWEEP'S INDEX, the counterpart to `listening_events_played_at_idx`.
     * Mongo's `{ expiresAt: 1 }, { expireAfterSeconds: 0 }` had no other
     * reader and neither does this — it exists so the sweep's
     * `expires_at <= now()` is a range scan rather than a full one.
     */
    index('notification_suppressions_expires_at_idx').on(t.expiresAt),
  ]
);
