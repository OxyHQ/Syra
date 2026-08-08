/**
 * Rooms and live schema — `houses`, `series`, `rooms`, `recordings` and the
 * per-user preference row, plus the three child tables their Mongo arrays
 * become.
 *
 * Ported from `packages/backend/src/models/{House,Room,RoomUserPreference,
 * Recording,Series}.ts`, field by field, against
 * `packages/backend/docs/db/RELATIONS.md` for every foreign key.
 *
 * ## `Room.topicId` is DROPPED — the dangling `ref: 'Topic'` resolved
 *
 * `models/Room.ts:224` declares `topicId: { type: Schema.Types.ObjectId, ref:
 * 'Topic' }` and **there is no `Topic` model anywhere in this repo**. Mongo
 * never checked the `ref`, so the declaration cost nothing and nobody noticed.
 * A real foreign key cannot point at a table that does not exist, so this port
 * had to decide rather than carry it, and the evidence says drop:
 *
 *   `grep -rn "topicId\|topic_id\|'Topic'" packages/backend/src` returns
 *   exactly THREE hits — the interface field (`models/Room.ts:89`), the schema
 *   path (`models/Room.ts:224`), and `routes/rooms.routes.ts:89`, which is one
 *   entry in the `PUBLIC_ROOM_FIELDS` response allowlist. There is no fourth.
 *   No route destructures `topicId` from a request body, no create or update
 *   path assigns it, no query filters or sorts on it, and no code resolves it
 *   to anything. The single "reader" copies a field that is `undefined` on
 *   every document ever written into a response object.
 *
 * That matches RELATIONS.md's own "Columns I could not find a reader for"
 * table, which reached the same conclusion independently and recommends the
 * drop. No `topics` table is invented to satisfy the reference, and no
 * unconstrained `topic_id` column is carried forward — a column nothing writes
 * is not a relation, it is a declaration nobody removed. `Room.topic` (the
 * free-text `string`, `models/Room.ts:219`) is a DIFFERENT and genuinely-used
 * field and is ported normally, as `rooms.topic`.
 *
 * One loose end this task deliberately does NOT touch, because it is live
 * Mongo-path code outside a schema task's scope: `PUBLIC_ROOM_FIELDS` still
 * lists `'topicId'` (`routes/rooms.routes.ts:89`). It is inert today (the
 * field is absent from every document) and stays inert, but whichever task
 * ports `rooms.routes.ts` off Mongoose must delete that entry in the same
 * change — there will be no column for it to name.
 *
 * ## Two child tables this task's brief did not name
 *
 * The brief's `Produces` list names six tables. Eight land, because two Mongo
 * arrays are arrays of OBJECTS with a known, shared sub-schema, and this
 * schema already settled what that shape becomes: a child table, regardless of
 * query-by-element evidence (`catalog.ts`'s `track_hls_renditions` correction
 * and `podcasts.ts`'s six child tables — the rule was written down precisely
 * because the same shape had been split two ways once already).
 *
 *  - `Room.podcastQueue[]` (`MediaQueueSchema`, `models/Room.ts:303-316`) →
 *    `room_media_queue_items`.
 *  - `Series.episodes[]` (`SeriesEpisodeSchema`, `models/Series.ts:128-141`) →
 *    `series_episodes`.
 *
 * `House.members[]` is the third array of that shape and WAS named by the
 * brief (`house_members`). Treating the other two differently would have been
 * the inconsistency, not the addition.
 *
 * `room_media_queue_items` is named for what the field IS rather than what it
 * is called: `models/Room.ts:118-123`'s own comment says "Named `podcastQueue`
 * for historical reasons — it is the generic up-next queue and may hold mixed
 * media kinds", and the `kind` discriminator on every row proves it. Same
 * class of decision as `library.ts` renaming `PlaylistTrack.order` to
 * `position`; flagged in this task's report rather than made quietly.
 *
 * ## Which arrays stayed arrays
 *
 * `Room.participants[]`, `Room.speakers[]`, `Room.tags[]`, `House.tags[]` and
 * `Series.roomTemplate.tags[]` are arrays of plain strings, read whole and
 * never queried by element — grepped every call site: they are assigned
 * wholesale at create time and mutated in memory on a loaded document
 * (`routes/rooms.routes.ts:1638-1642`), never used as a query filter. `text[]`,
 * the same treatment `library.ts` gives `PlaybackState.queue[]` and
 * `Device.capabilities[]`.
 *
 * `Recording.participantIds[]` is the ONE exception and gets a GIN index,
 * because it IS queried by element: `routes/rooms.routes.ts:2718` filters
 * `{ access: 'participants', participantIds: userId }` on the per-room
 * recording listing, which is how a participant sees a recording that is not
 * public. Same treatment as `tracks.tags` in `catalog.ts` — an array with a
 * real containment reader earns the GIN, one without it does not.
 *
 * ## Which subdocuments were flattened
 *
 * `House.visibility`, `Room.stats`, `Series.recurrence` and
 * `Series.roomTemplate` are each a SINGLE subdocument, not an array, so each
 * flattens onto its parent row — the same treatment `podcasts.ts` gives
 * `Episode.cache`/`Episode.chapters` and `catalog.ts` gives
 * `Track.audioSource`. `recurrence` and `roomTemplate` are `required: true` on
 * the parent (`models/Series.ts:174-181`), so their own required inner fields
 * stay `notNull` here; `House.visibility` and `Room.stats` have per-field
 * defaults that survive the flattening unchanged.
 *
 * ## `recordings.room_id` is nullable, and that is a deliberate improvement
 *
 * `models/Recording.ts:41-45` declares `roomId` `required: true`, but rooms
 * ARE hard-deleted (`routes/rooms.routes.ts:2515`) with **no check for
 * existing recordings and no cleanup** — so a room with recordings can be
 * deleted today, leaving `Recording.roomId` pointing at nothing while the
 * schema still claims it is required. RELATIONS.md flags exactly this and
 * recommends the fix be made HERE: relax to nullable and `ON DELETE SET NULL`.
 *
 * Neither alternative is right. `CASCADE` would delete recorded audio because
 * someone tidied up a room — recordings are a standalone resource with their
 * own `expiresAt`/`access`, served by their own routes. `RESTRICT` would
 * refuse a room deletion the app performs freely today, which is a live
 * behaviour change. `SET NULL` promotes today's silent dangling reference into
 * an explicit, honest one.
 *
 * ## `recordings.expires_at` is written by everything and read by nothing
 *
 * `routes/rooms.routes.ts:835` stamps `expiresAt = now + 6 months` on every
 * recording, and `models/Recording.ts:112` indexes `{ expiresAt, status }` —
 * for a sweeper that does not exist. Grepped the whole backend: no scheduled
 * job, no cron, no route, and no script ever queries `Recording` by
 * `expiresAt`; the only deletion path is a user pressing delete
 * (`routes/recordings.routes.ts:167`). The declared six-month retention has
 * never once been enforced.
 *
 * The column is ported (it is written on every row, and the intent is real).
 * The INDEX is not, per this schema's "an index with no reader is dropped in
 * writing" convention — and deliberately no `EXPIRY_SWEEP_TARGETS` entry is
 * added either, because `db/expiry.ts`'s registry replaces a Mongo TTL index,
 * and this was never one: adding a sweep here would start deleting recordings
 * Mongo has never deleted, which is a product decision and not a port. Raised
 * in this task's report instead. Whoever adds the sweeper adds the supporting
 * index with it — `findUnsupportedExpiryColumns` will fail the gate if they
 * do not.
 *
 * ## Indexes dropped, and why
 *
 * Every drop below replaces a Mongo `index: true` (or a compound index) with
 * NOTHING, because tracing the real call sites found no reader:
 *
 *  - `Series.{ isActive, 'recurrence.type' }` — its own comment says "Find
 *    active series for scheduling". There is no scheduler: episodes are
 *    generated by an explicit `POST /:id/generate-episode`
 *    (`routes/series.routes.ts:377-430`), and `grep -rn "Series"
 *    packages/backend/src/services` returns nothing at all. An index for a
 *    background job nobody built.
 *  - `Room.{ seriesId, scheduledStart }` — nothing queries a room by
 *    `seriesId`. It is assigned once (`routes/series.routes.ts:415`) and
 *    listed in the response allowlist; that is all. `rooms_series_id_idx`
 *    below exists for a different reason (the `ON DELETE SET NULL` lookup),
 *    and is deliberately not the compound Mongo declared.
 *  - `Recording.{ host, status, createdAt }` — `Recording.find({ host })` has
 *    no call site. `host` is read only as a `$group` key
 *    (`routes/rooms.routes.ts:1128`, top-hosts), which is served by
 *    `recordings_ready_host_idx` below — an index that matches the query that
 *    exists rather than the one Mongo declared.
 *  - `Recording.{ expiresAt, status }` — see above.
 *  - `House.createdBy` / `Series.createdBy` standalone — grepped: neither is
 *    ever a query filter. Both are read off an already-loaded document for
 *    permission checks, the same shape `podcasts.ts` dropped
 *    `podcasts.claimable` for.
 *  - `Recording.roomId` standalone — the leading column of
 *    `recordings_room_id_status_created_at_idx` below, so a second index buys
 *    nothing. `Recording.status` and `Recording.host` standalone are dropped
 *    for a DIFFERENT reason, and an earlier version of this list wrongly gave
 *    all three the same one: no `recordings` index leads with `status` at all
 *    (it appears only inside two partial predicates), and `host` leads only a
 *    partial index. They are dropped because every query that exists is
 *    already covered by the two partial indexes built for it — not because a
 *    compound index subsumes them.
 *
 * ## The four columns `PROTECTED_COLUMNS_BY_TABLE` gains
 *
 * `rtmpStreamKey`, `rtmpUrl`, `activeStreamUrl` and `activeIngressId` are the
 * internal stream credentials `PUBLIC_ROOM_FIELDS` exists to withhold — a live
 * RTMP publishing key is a WRITE capability, not just a private field, and the
 * repo already carries a dedicated regression test for its exposure
 * (`routes/streamCredentialExposure.test.ts`). Registering them gives the port
 * a second, independent guard: `findImplicitWholeRowReads` refuses a bare
 * `db.select().from(rooms)` outright.
 *
 * `recordings.objectKey` is deliberately NOT registered, even though it is an
 * S3 key that reaches clients today (`routes/recordings.routes.ts:41` returns
 * whole `.lean()` documents). `catalog.ts` does not protect the identical
 * `tracks.audioSourceKey`/`hlsMasterKey`, and `protectedColumns.ts` says so in
 * writing — a storage key is guarded by hand-written DTO allowlists in both
 * verticals, not by this registry. Treating this one differently would be the
 * divergence.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, tsvector, updatedAt } from '@oxyhq/db';

// ── Closed value sets ────────────────────────────────────────────────────
// Same convention as catalog.ts/library.ts/podcasts.ts: one `as const` tuple
// per closed value set, used both to type the column and to derive its CHECK.

/** `models/House.ts` `HouseMemberRole`. */
export const HOUSE_MEMBER_ROLES = ['owner', 'admin', 'host', 'member'] as const;

/** `models/House.ts` `HouseDiscovery` — may this user learn the house exists? */
export const HOUSE_DISCOVERY_LEVELS = ['listed', 'unlisted', 'hidden'] as const;

/** `models/House.ts` `HouseRooms` — may this user see and enter what is inside? */
export const HOUSE_ROOM_ACCESS_LEVELS = ['anyone', 'members'] as const;

/** `models/House.ts` `HouseJoin` — how does a non-member become a member? */
export const HOUSE_JOIN_POLICIES = ['anyone', 'invite'] as const;

/** `models/Room.ts` `RoomStatus`. */
export const ROOM_STATUSES = ['scheduled', 'live', 'ended'] as const;

/** `models/Room.ts` `RoomType`. */
export const ROOM_TYPES = ['talk', 'stage', 'broadcast'] as const;

/** `models/Room.ts` `OwnerType`. */
export const ROOM_OWNER_TYPES = ['profile', 'house', 'agora'] as const;

/** `models/Room.ts` `BroadcastKind` — only meaningful when `type = 'broadcast'`. */
export const ROOM_BROADCAST_KINDS = ['user', 'agora'] as const;

/** `models/Room.ts` `SpeakerPermission`. */
export const ROOM_SPEAKER_PERMISSIONS = ['everyone', 'followers', 'invited'] as const;

/** `models/Room.ts` `MediaQueueKind` — which id fields on a queue row are meaningful. */
export const MEDIA_QUEUE_KINDS = ['podcast', 'track'] as const;

/** `models/Series.ts` `RecurrenceType`. */
export const SERIES_RECURRENCE_TYPES = ['daily', 'weekly', 'biweekly', 'monthly'] as const;

/** `models/Recording.ts` `RecordingStatus`. */
export const RECORDING_STATUSES = ['recording', 'processing', 'ready', 'failed', 'deleted'] as const;

/** `models/Recording.ts` `RecordingAccess`. */
export const RECORDING_ACCESS_LEVELS = ['public', 'participants'] as const;

/** `models/RoomUserPreference.ts` `LiveVisibility`. */
export const LIVE_VISIBILITIES = ['active', 'speaking'] as const;

// ── Mongoose `maxlength` declarations, ported as CHECKs ───────────────────
// Mongoose enforces these on every save today, so dropping them would quietly
// loosen validation the application still relies on. Same treatment
// `creators.ts` gives `ArtistClaim.evidence`.

/** `models/House.ts:169-179`. */
const HOUSE_NAME_MAX_LENGTH = 100;
const HOUSE_DESCRIPTION_MAX_LENGTH = 500;

/** `models/Room.ts:132-143,219-223,269-285`. */
const ROOM_TITLE_MAX_LENGTH = 200;
const ROOM_DESCRIPTION_MAX_LENGTH = 500;
const ROOM_TOPIC_MAX_LENGTH = 100;
const ROOM_STREAM_TITLE_MAX_LENGTH = 200;
const ROOM_STREAM_DESCRIPTION_MAX_LENGTH = 500;

/** `models/Series.ts:93-110,144-154`. */
const SERIES_TITLE_MAX_LENGTH = 200;
const SERIES_DESCRIPTION_MAX_LENGTH = 500;
const SERIES_TITLE_PATTERN_MAX_LENGTH = 200;
const SERIES_TEMPLATE_DESCRIPTION_MAX_LENGTH = 500;

// ── houses ────────────────────────────────────────────────────────────────

export const houses = pgTable(
  'houses',
  {
    id: generatedId(),
    name: text().notNull(),
    description: text(),
    /**
     * A raw S3 CDN URL string, NOT an `image_assets` reference — unlike every
     * `coverArt`/`image` field in `catalog.ts`/`podcasts.ts`.
     * `routes/houses.routes.ts:761-770` assigns `house.avatar = cdnUrl`
     * directly with no `ObjectId` validation. RELATIONS.md fact 5 names this
     * exact distinction and lists these two columns on the non-`ImageAsset`
     * side of it.
     */
    avatar: text(),
    coverImage: text(),
    /** An Oxy account id — no foreign key. Not `*_id`-suffixed. */
    createdBy: text().notNull(),
    // `visibility` is a single subdocument, flattened — see the file-level doc
    // comment. Three ORTHOGONAL axes, not one ladder; `models/House.ts:12-60`
    // documents each at length. Defaults reproduce the old `isPublic: true`.
    visibilityDiscovery: text({ enum: HOUSE_DISCOVERY_LEVELS }).notNull().default('listed'),
    visibilityRooms: text({ enum: HOUSE_ROOM_ACCESS_LEVELS }).notNull().default('anyone'),
    visibilityJoin: text({ enum: HOUSE_JOIN_POLICIES }).notNull().default('invite'),
    // The member ROSTER is `house_members` (child table, below).
    tags: text().array().notNull().default(sql`array[]::text[]`),
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('english', name || ' ' || coalesce(description, ''))`
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'houses_visibility_discovery_check',
      sql`${t.visibilityDiscovery} in (${sql.raw(inList(HOUSE_DISCOVERY_LEVELS))})`
    ),
    check(
      'houses_visibility_rooms_check',
      sql`${t.visibilityRooms} in (${sql.raw(inList(HOUSE_ROOM_ACCESS_LEVELS))})`
    ),
    check(
      'houses_visibility_join_check',
      sql`${t.visibilityJoin} in (${sql.raw(inList(HOUSE_JOIN_POLICIES))})`
    ),
    check(
      'houses_name_length_check',
      sql`char_length(${t.name}) <= ${sql.raw(String(HOUSE_NAME_MAX_LENGTH))}`
    ),
    check(
      'houses_description_length_check',
      sql`${t.description} is null or char_length(${t.description}) <= ${sql.raw(String(HOUSE_DESCRIPTION_MAX_LENGTH))}`
    ),
    // `GET /api/houses` — the discoverable listing, newest first
    // (routes/houses.routes.ts:210). Non-partial on purpose: the query is a
    // `$nin`/NOT IN over the axis, so no single value can be baked into a
    // predicate.
    index('houses_visibility_discovery_created_at_idx').on(t.visibilityDiscovery, t.createdAt.desc()),
    /**
     * The `rooms` axis on its own, so `houseIdsWithRoomsHiddenFrom`
     * (`models/House.ts:331`) can be served by an index union with the
     * `discovery` index above rather than a scan. That helper runs on EVERY
     * global room listing, which is the hottest path in this vertical.
     */
    index('houses_visibility_rooms_idx').on(t.visibilityRooms),
    // Replaces Mongo's `{ name: 'text', description: 'text' }`, which
    // `routes/houses.routes.ts:203` queries with `$text`.
    index('houses_search_gin').using('gin', t.searchVector),
  ]
);

// ── house_members (child of houses — the membership roster) ────────────────

export const houseMembers = pgTable(
  'house_members',
  {
    id: generatedId(),
    houseId: text()
      .notNull()
      .references(() => houses.id, { onDelete: 'cascade' }),
    /**
     * An Oxy account id — no foreign key. Named `oxyUserId`, not Mongo's
     * `userId` (`models/House.ts:98`): every Oxy account id in this schema is
     * `oxy_user_id` across all 51 tables that preceded this one, and this is
     * the same thing (RELATIONS.md classifies it CROSS-SERVICE alongside
     * them). Two names for one concept is what the rename avoids.
     */
    oxyUserId: text().notNull(),
    role: text({ enum: HOUSE_MEMBER_ROLES }).notNull().default('member'),
    joinedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    check('house_members_role_check', sql`${t.role} in (${sql.raw(inList(HOUSE_MEMBER_ROLES))})`),
    /**
     * One membership row per (house, user) — `routes/houses.routes.ts` treats
     * `members` as a set (`house.members.find(...)` before every add), which
     * this enforces for real. No `position` column, unlike the ordinal child
     * tables in `catalog.ts`/`podcasts.ts`: a roster is a SET, not an ordered
     * list, and nothing reads member order. Exactly the shape
     * `playlist_collaborators` (`library.ts`) already has.
     */
    unique('house_members_house_id_oxy_user_id_key').on(t.houseId, t.oxyUserId),
    // The REVERSE direction — "every house this user belongs to" — which the
    // listing's `{ 'members.userId': userId }` branch and
    // `houseIdsWithRoomsHiddenFrom`'s `$ne` both need. Not served by the
    // unique index above, which leads with house_id.
    index('house_members_oxy_user_id_idx').on(t.oxyUserId),
  ]
);

// ── series ────────────────────────────────────────────────────────────────

export const series = pgTable(
  'series',
  {
    id: generatedId(),
    title: text().notNull(),
    description: text(),
    /** A raw S3 CDN URL string, not an `image_assets` reference — see `houses.avatar`. */
    coverImage: text(),
    houseId: text().references(() => houses.id, { onDelete: 'set null' }),
    /** An Oxy account id — no foreign key. Not `*_id`-suffixed. */
    createdBy: text().notNull(),
    // `recurrence` is a single REQUIRED subdocument, flattened — its own
    // required inner fields stay notNull. See the file-level doc comment.
    recurrenceType: text({ enum: SERIES_RECURRENCE_TYPES }).notNull(),
    /** 0 = Sunday … 6 = Saturday; only meaningful for weekly/biweekly. */
    recurrenceDayOfWeek: integer(),
    /** 1-31; only meaningful for monthly. */
    recurrenceDayOfMonth: integer(),
    /** `HH:mm`, 24-hour — the CHECK below is Mongoose's own `match` regex. */
    recurrenceTime: text().notNull(),
    /** An IANA timezone, e.g. `America/New_York`. */
    recurrenceTimezone: text().notNull().default('UTC'),
    // `roomTemplate` is the other single REQUIRED subdocument, flattened.
    roomTemplateTitlePattern: text().notNull(),
    roomTemplateType: text({ enum: ROOM_TYPES }).notNull().default('talk'),
    roomTemplateDescription: text(),
    roomTemplateMaxParticipants: integer().notNull().default(100),
    roomTemplateSpeakerPermission: text({ enum: ROOM_SPEAKER_PERMISSIONS }).notNull().default('invited'),
    roomTemplateTags: text().array().notNull().default(sql`array[]::text[]`),
    // The generated-episode LOG is `series_episodes` (child table, below).
    nextEpisodeNumber: integer().notNull().default(1),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'series_recurrence_type_check',
      sql`${t.recurrenceType} in (${sql.raw(inList(SERIES_RECURRENCE_TYPES))})`
    ),
    check(
      'series_recurrence_day_of_week_check',
      sql`${t.recurrenceDayOfWeek} is null or ${t.recurrenceDayOfWeek} between 0 and 6`
    ),
    check(
      'series_recurrence_day_of_month_check',
      sql`${t.recurrenceDayOfMonth} is null or ${t.recurrenceDayOfMonth} between 1 and 31`
    ),
    // Mongoose's own `match: /^\d{2}:\d{2}$/` (models/Series.ts:84). `~` with
    // an anchored POSIX class is the same assertion.
    check('series_recurrence_time_check', sql`${t.recurrenceTime} ~ '^[0-9]{2}:[0-9]{2}$'`),
    check(
      'series_room_template_type_check',
      sql`${t.roomTemplateType} in (${sql.raw(inList(ROOM_TYPES))})`
    ),
    check(
      'series_room_template_max_participants_check',
      sql`${t.roomTemplateMaxParticipants} between 1 and 10000`
    ),
    check(
      'series_room_template_speaker_permission_check',
      sql`${t.roomTemplateSpeakerPermission} in (${sql.raw(inList(ROOM_SPEAKER_PERMISSIONS))})`
    ),
    check('series_next_episode_number_check', sql`${t.nextEpisodeNumber} >= 1`),
    check(
      'series_title_length_check',
      sql`char_length(${t.title}) <= ${sql.raw(String(SERIES_TITLE_MAX_LENGTH))}`
    ),
    check(
      'series_description_length_check',
      sql`${t.description} is null or char_length(${t.description}) <= ${sql.raw(String(SERIES_DESCRIPTION_MAX_LENGTH))}`
    ),
    check(
      'series_room_template_title_pattern_length_check',
      sql`char_length(${t.roomTemplateTitlePattern}) <= ${sql.raw(String(SERIES_TITLE_PATTERN_MAX_LENGTH))}`
    ),
    check(
      'series_room_template_description_length_check',
      sql`${t.roomTemplateDescription} is null or char_length(${t.roomTemplateDescription}) <= ${sql.raw(String(SERIES_TEMPLATE_DESCRIPTION_MAX_LENGTH))}`
    ),
    /**
     * `GET /api/houses/:id/series` — the only listing there is
     * (`routes/houses.routes.ts:716`), which filters `{ houseId, isActive:
     * true }` and sorts `createdAt` desc. Partial on the predicate the real
     * query always carries, the same convention Task 2/3/4 used.
     *
     * A LISTING index only. An earlier version of this comment also claimed it
     * was the `ON DELETE SET NULL` support index for `series.house_id`; it
     * cannot be, because it is partial on `is_active` and the RI query carries
     * no such clause — that is `series_house_id_idx`, below.
     */
    index('series_house_id_active_created_at_idx')
      .on(t.houseId, t.createdAt.desc())
      .where(sql`${t.isActive} = true`),
    /**
     * Support for `houses`' `ON DELETE SET NULL` on `series.house_id` — the
     * fourth constraint-support index, and MUST STAY NON-PARTIAL for the same
     * reason as `rooms_house_id_idx`. Deleting a house sequential-scanned
     * `series` before this existed.
     */
    index('series_house_id_idx').on(t.houseId),
  ]
);

// ── rooms ─────────────────────────────────────────────────────────────────

export const rooms = pgTable(
  'rooms',
  {
    id: generatedId(),
    title: text().notNull(),
    description: text(),
    // ── Ownership ─────────────────────────────────────────────────────────
    ownerType: text({ enum: ROOM_OWNER_TYPES }).notNull().default('profile'),
    /** The creator/primary host's Oxy account id — no foreign key. */
    host: text().notNull(),
    /**
     * Set when `ownerType = 'house'`; `null` for a profile-owned room.
     *
     * `SET NULL` on a house deletion, which replaces today's silent dangling
     * reference (`routes/houses.routes.ts:354` deletes a house with no cleanup
     * at all) with an explicit null. **It does NOT produce a profile-owned
     * room, and an earlier version of this comment wrongly said it did:**
     * `owner_type` is untouched, so the surviving row sits at
     * `owner_type = 'house'`, `house_id = null` — a combination
     * `RoomSchema.pre('validate')` (`models/Room.ts:352-355`) would refuse to
     * SAVE, and which no CHECK here forbids.
     *
     * That is deliberate, and it is why the third `pre('validate')` invariant
     * is NOT ported as a CHECK (the other two are — see the two `broadcast`
     * CHECKs below). `owner_type <> 'house' or house_id is not null` would be
     * broken by this very constraint unless the FK could null `owner_type` in
     * the same action, which Postgres cannot express through drizzle. Choosing
     * between them means deciding what should happen to a house's rooms when
     * the house is deleted — cascade, restrict, or reassign to the creator —
     * and that is a product question, recorded in this task's report rather
     * than settled here.
     *
     * Not a security hole: the one reader that dereferences the pair,
     * `canManageRoom` (`routes/rooms.routes.ts:151-154`), returns `false` on a
     * missing `houseId`, so it fails closed. The state is also already
     * reachable today through a stale id (`House.findById` → null). This is a
     * dropped validation, not a vulnerability.
     */
    houseId: text().references(() => houses.id, { onDelete: 'set null' }),
    /** An Oxy account id — no foreign key. Audit trail for agora-owned rooms. */
    createdByAdmin: text(),
    // ── Classification ────────────────────────────────────────────────────
    type: text({ enum: ROOM_TYPES }).notNull().default('talk'),
    /**
     * Only set when `type = 'broadcast'` — enforced by
     * `rooms_broadcast_kind_check` below, not merely asserted here.
     * `models/Room.ts:349-351` clears it on every save of a non-broadcast
     * room, and this comment previously cited that hook while nothing in the
     * schema held the line.
     *
     * Only the ONE direction is a CHECK. The hook's other half (a broadcast
     * room with no `broadcastKind` gets defaulted to `'user'`,
     * `models/Room.ts:345-347`) is deliberately NOT expressed as
     * `type <> 'broadcast' or broadcast_kind is not null`: Postgres has no
     * per-row conditional default, so that CHECK would REJECT an insert
     * Mongoose accepts and silently fills in. Enforcing it would tighten the
     * contract past what the application does, which is a different thing from
     * porting it.
     */
    broadcastKind: text({ enum: ROOM_BROADCAST_KINDS }),
    // ── Lifecycle ─────────────────────────────────────────────────────────
    status: text({ enum: ROOM_STATUSES }).notNull().default('scheduled'),
    scheduledStart: timestamptz(),
    startedAt: timestamptz(),
    endedAt: timestamptz(),
    // ── Participation ─────────────────────────────────────────────────────
    speakerPermission: text({ enum: ROOM_SPEAKER_PERMISSIONS }).notNull().default('invited'),
    // Oxy account ids, read whole and never queried by element — see the
    // file-level doc comment.
    participants: text().array().notNull().default(sql`array[]::text[]`),
    speakers: text().array().notNull().default(sql`array[]::text[]`),
    maxParticipants: integer().notNull().default(100),
    // ── Content ───────────────────────────────────────────────────────────
    /** Free text. NOT `Room.topicId`, which is dropped — see the file-level doc comment. */
    topic: text(),
    tags: text().array().notNull().default(sql`array[]::text[]`),
    archived: boolean().notNull().default(false),
    /**
     * Set when this room was generated from a series template
     * (`routes/series.routes.ts:415`). Same "already-meaningful absence"
     * reasoning as `houseId`: most rooms have no series at all, and series
     * deletion leaves this dangling today with no cleanup.
     */
    seriesId: text().references(() => series.id, { onDelete: 'set null' }),
    // ── Stats (a single subdocument, flattened) ───────────────────────────
    statsPeakListeners: integer().notNull().default(0),
    statsTotalJoined: integer().notNull().default(0),
    // ── Recording ─────────────────────────────────────────────────────────
    recordingEnabled: boolean().notNull().default(true),
    /** LiveKit's own egress job id — EXTERNAL, not a Syra row. */
    recordingEgressId: text(),
    // ── Streaming ─────────────────────────────────────────────────────────
    /**
     * LiveKit's own ingress id — EXTERNAL, not a Syra row. An internal stream
     * credential: registered in `PROTECTED_COLUMNS_BY_TABLE`, absent from
     * `PUBLIC_ROOM_FIELDS`.
     */
    activeIngressId: text(),
    /** Internal stream credential — see `activeIngressId`. */
    activeStreamUrl: text(),
    streamTitle: text(),
    streamImage: text(),
    streamDescription: text(),
    /** Internal stream credential — see `activeIngressId`. */
    rtmpUrl: text(),
    /** A live RTMP PUBLISHING key — the most sensitive column on this table. */
    rtmpStreamKey: text(),
    /** When the current stream's ingress started; cleared whenever it stops. */
    streamStartedAt: timestamptz(),
    /**
     * `doublePrecision`, not `integer`: it mirrors a podcast episode's own
     * duration (`routes/rooms.routes.ts:351`, `meta.durationSec`), and
     * `episodes.duration` is `doublePrecision` in `podcasts.ts`. Absent for
     * open-ended streams (RTMP, arbitrary URLs).
     */
    streamDurationSec: doublePrecision(),
    // The up-next queue is `room_media_queue_items` (child table, below).
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('rooms_owner_type_check', sql`${t.ownerType} in (${sql.raw(inList(ROOM_OWNER_TYPES))})`),
    check('rooms_type_check', sql`${t.type} in (${sql.raw(inList(ROOM_TYPES))})`),
    check(
      'rooms_broadcast_kind_check',
      sql`${t.broadcastKind} is null or ${t.broadcastKind} in (${sql.raw(inList(ROOM_BROADCAST_KINDS))})`
    ),
    check('rooms_status_check', sql`${t.status} in (${sql.raw(inList(ROOM_STATUSES))})`),
    check(
      'rooms_speaker_permission_check',
      sql`${t.speakerPermission} in (${sql.raw(inList(ROOM_SPEAKER_PERMISSIONS))})`
    ),
    /**
     * `RoomSchema.pre('validate')` (`models/Room.ts:349-351`) clears
     * `broadcastKind` on every save of a non-broadcast room. Ported on the same
     * grounds as the 11 `maxlength`/`match` CHECKs below — Mongoose enforces it
     * on every save today, so leaving it out would quietly loosen validation.
     * See the `broadcastKind` column for why only this direction is a CHECK.
     */
    // Named `..._requires_type_check`, not `rooms_broadcast_kind_check` —
    // that name is already taken by the enum-membership CHECK above, and
    // `drizzle-kit generate` refuses a duplicate constraint name within a
    // schema rather than silently emitting one that shadows the other.
    check(
      'rooms_broadcast_kind_requires_type_check',
      sql`${t.type} = 'broadcast' or ${t.broadcastKind} is null`
    ),
    /**
     * The other half of the same hook (`models/Room.ts:357-359`): a broadcast
     * room's speaker permission is forced to `'invited'`, because a broadcast
     * is not a room anyone may speak in. Expressible with no conflict — the
     * column already defaults to `'invited'`, so this rejects only an explicit
     * widening that Mongoose would have silently overwritten.
     */
    check(
      'rooms_broadcast_speaker_permission_check',
      sql`${t.type} <> 'broadcast' or ${t.speakerPermission} = 'invited'`
    ),
    check('rooms_max_participants_check', sql`${t.maxParticipants} between 1 and 10000`),
    check('rooms_stats_peak_listeners_check', sql`${t.statsPeakListeners} >= 0`),
    check('rooms_stats_total_joined_check', sql`${t.statsTotalJoined} >= 0`),
    check(
      'rooms_stream_duration_sec_check',
      sql`${t.streamDurationSec} is null or ${t.streamDurationSec} >= 0`
    ),
    check(
      'rooms_title_length_check',
      sql`char_length(${t.title}) <= ${sql.raw(String(ROOM_TITLE_MAX_LENGTH))}`
    ),
    check(
      'rooms_description_length_check',
      sql`${t.description} is null or char_length(${t.description}) <= ${sql.raw(String(ROOM_DESCRIPTION_MAX_LENGTH))}`
    ),
    check(
      'rooms_topic_length_check',
      sql`${t.topic} is null or char_length(${t.topic}) <= ${sql.raw(String(ROOM_TOPIC_MAX_LENGTH))}`
    ),
    check(
      'rooms_stream_title_length_check',
      sql`${t.streamTitle} is null or char_length(${t.streamTitle}) <= ${sql.raw(String(ROOM_STREAM_TITLE_MAX_LENGTH))}`
    ),
    check(
      'rooms_stream_description_length_check',
      sql`${t.streamDescription} is null or char_length(${t.streamDescription}) <= ${sql.raw(String(ROOM_STREAM_DESCRIPTION_MAX_LENGTH))}`
    ),
    /**
     * The five listing indexes below are all partial on `archived = false`,
     * because BOTH room listings — the global one
     * (`routes/rooms.routes.ts:1031`) and the per-house one
     * (`routes/houses.routes.ts:647`) — open with `archived: { $ne: true }`
     * unconditionally. Each `WHERE`-free variant would index rows no listing
     * can ever return.
     *
     * The default listing: status (one value or the live/scheduled pair),
     * newest first.
     *
     * IT DOES NOT SERVE `Room.find({ status: 'live' })` — the live-users badge
     * feed (`routes/rooms.routes.ts:1213`) — and an earlier version of this
     * comment claimed it did "as a prefix". A partial index is unusable unless
     * the query's predicate IMPLIES the index predicate, and that query carries
     * no `archived` clause at all, so it sequential-scans `rooms` on every
     * request (measured with `enable_seqscan = off`; adding
     * `and archived = false` to the same query flips it to an index scan, which
     * is the proof that the predicate and not the column list is what excluded
     * it). **The ported live-users query MUST carry `archived = false`.**
     *
     * That requirement is not merely a performance fix, which is why it is
     * stated as a requirement rather than solved with a second index:
     * `archived` is the MODERATION restriction lever for a room — per
     * `moderation/enforcement-service.ts:98`, "the only lever a room has that
     * does not end a live session out from under the people in it" — so an
     * archived room is routinely `status = 'live'` at the same time. Today's
     * unfiltered query therefore still emits a live badge for a room a
     * moderator has restricted. Flagged in this task's report as a pre-existing
     * moderation gap the port should close, not carry.
     */
    index('rooms_status_created_at_idx')
      .on(t.status, t.createdAt.desc())
      .where(sql`${t.archived} = false`),
    // `GET /api/houses/:id/rooms`, and the global listing's own `?houseId=`
    // filter. A LISTING index only — the `ON DELETE SET NULL` support index for
    // `house_id` is the separate non-partial one below, for the reason given
    // there.
    index('rooms_house_id_status_created_at_idx')
      .on(t.houseId, t.status, t.createdAt.desc())
      .where(sql`${t.archived} = false`),
    // The global listing's `?host=` filter.
    index('rooms_host_status_created_at_idx')
      .on(t.host, t.status, t.createdAt.desc())
      .where(sql`${t.archived} = false`),
    // The global listing's `?type=` filter (also `?type=` on the house one).
    index('rooms_type_status_created_at_idx')
      .on(t.type, t.status, t.createdAt.desc())
      .where(sql`${t.archived} = false`),
    // The global listing's `?ownerType=` filter, e.g. every agora broadcast.
    index('rooms_owner_type_type_status_created_at_idx')
      .on(t.ownerType, t.type, t.status, t.createdAt.desc())
      .where(sql`${t.archived} = false`),
    /**
     * `Room.findOne({ activeIngressId })` — `routes/livekitWebhook.routes.ts:76`,
     * which runs on EVERY LiveKit webhook delivery. Mongo has no index for it
     * at all, so this is a genuine improvement rather than a port; partial
     * because the column is null on every room that is not currently
     * streaming, which is nearly all of them.
     */
    index('rooms_active_ingress_id_idx')
      .on(t.activeIngressId)
      .where(sql`${t.activeIngressId} is not null`),
    /**
     * Support for `series`' `ON DELETE SET NULL`, which has to find every
     * referencing room. Deliberately NOT Mongo's `{ seriesId, scheduledStart }`
     * compound — nothing queries a room by series (see the file-level doc
     * comment), so the sort key would be indexing for a reader that does not
     * exist.
     *
     * MUST STAY NON-PARTIAL, for the same reason as
     * `recordings_room_id_status_created_at_idx`: it exists for a constraint,
     * not a query, and a constraint has to see every row. Asserted by
     * definition in `__tests__/gates.test.ts`.
     */
    index('rooms_series_id_idx').on(t.seriesId),
    /**
     * Support for `houses`' `ON DELETE SET NULL` on `house_id`, and one of the
     * FIVE indexes in this schema that exist for a CONSTRAINT rather than a
     * query — so, MUST STAY NON-PARTIAL. The other four are
     * `series_house_id_idx`, `rooms_series_id_idx`,
     * `series_episodes_room_id_idx` and
     * `recordings_room_id_status_created_at_idx`: one per `ON DELETE SET NULL`
     * in this file, which is the set `gates.test.ts` enumerates rather than
     * counts, so the two cannot drift apart.
     *
     * It looks redundant beside `rooms_house_id_status_created_at_idx` and is
     * not, which is exactly the trap it exists to close: that index is partial
     * on `archived = false`, and the referential-integrity query Postgres runs
     * for the SET NULL is `select 1 from only rooms x where house_id = $1 for
     * key share of x` — no `archived` clause, and it MUST find archived rows
     * too. A partial index cannot serve it, so before this index existed,
     * deleting a house sequential-scanned the whole `rooms` table. Measured
     * with `enable_seqscan = off`, against working controls; the review that
     * caught it is `task-6-review.md` I1. `gates.test.ts` now asserts the plan
     * for this exact query, not just the index definition.
     */
    index('rooms_house_id_idx').on(t.houseId),
  ]
);

// ── room_media_queue_items (child of rooms — Mongo's `podcastQueue`) ───────

export const roomMediaQueueItems = pgTable(
  'room_media_queue_items',
  {
    id: generatedId(),
    roomId: text()
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    /** Discriminates which id column below is meaningful — see the CHECK. */
    kind: text({ enum: MEDIA_QUEUE_KINDS }).notNull(),
    /**
     * Optional show-level pairing check for a `kind = 'podcast'` row, and the
     * two id columns below: all three are resolved OUT OF PROCESS, through
     * Syra's own SDK client over HTTP (`routes/rooms.routes.ts:538-565,578-605`
     * → `syraClient.getEpisode` / `utils/syraMedia.ts`), never by a database
     * join. RELATIONS.md classifies all three as logical foreign keys and
     * recommends plain unconstrained columns for exactly that indirection —
     * ledger entries in `deferredForeignKeys.ts`. `podcasts`, `episodes` and
     * `tracks` all exist now, so a real key IS expressible today; not
     * declaring one is following RELATIONS.md's recommendation, and this task's
     * report says so explicitly rather than leaving it to be inferred.
     */
    syraPodcastId: text(),
    episodeId: text(),
    trackId: text(),
  },
  (t) => [
    check('room_media_queue_items_kind_check', sql`${t.kind} in (${sql.raw(inList(MEDIA_QUEUE_KINDS))})`),
    check('room_media_queue_items_position_check', sql`${t.position} >= 0`),
    /**
     * `models/Room.ts:39-51` asserts that "the parse/seed paths guarantee the
     * right fields are populated for each kind" — a guarantee nothing enforced.
     * It is true of every writer: `parsePodcastQueue` refuses an item with no
     * `episodeId` and emits `{ kind: 'podcast', episodeId, syraPodcastId? }`;
     * `parseTrackQueue` and `resolveAlbumTracks`/`resolvePlaylistTracks`
     * (`utils/syraMedia.ts:232`) refuse an item with no `trackId` and emit
     * `{ kind: 'track', trackId }` and nothing else. This CHECK is that
     * sentence, written as a constraint — including the negative half, which
     * is what stops a `'track'` row from smuggling an `episodeId` past it.
     */
    check(
      'room_media_queue_items_kind_ids_check',
      sql`(${t.kind} = 'podcast' and ${t.episodeId} is not null and ${t.trackId} is null)
          or (${t.kind} = 'track' and ${t.trackId} is not null and ${t.episodeId} is null and ${t.syraPodcastId} is null)`
    ),
    // Preserves the Mongo array's ORDER — this queue is popped head-first
    // (`advancePodcastQueueForRoom`), so a lost order is a lost queue.
    unique('room_media_queue_items_room_id_position_key').on(t.roomId, t.position),
  ]
);

// ── series_episodes (child of series — the generated-episode log) ──────────

export const seriesEpisodes = pgTable(
  'series_episodes',
  {
    id: generatedId(),
    seriesId: text()
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    /**
     * `SET NULL`, not `CASCADE`: this is an append-only history of what the
     * series has scheduled, so deleting one generated room must not erase the
     * record that an episode N was ever scheduled at all. RELATIONS.md names
     * this exact behaviour for the case where the array becomes its own child
     * table, which is what happened here.
     */
    roomId: text().references(() => rooms.id, { onDelete: 'set null' }),
    scheduledStart: timestamptz().notNull(),
    /**
     * The series' own 1-based counter (`Series.nextEpisodeNumber` at write
     * time), distinct from `position`, which preserves the Mongo array's
     * index. Both are ported because both exist: `position` is this schema's
     * ordinal convention for every array-turned-child-table, `episodeNumber`
     * is a domain value that appears in generated room titles
     * (`titlePattern`'s `{n}`).
     */
    episodeNumber: integer().notNull(),
  },
  (t) => [
    check('series_episodes_position_check', sql`${t.position} >= 0`),
    check('series_episodes_episode_number_check', sql`${t.episodeNumber} >= 1`),
    unique('series_episodes_series_id_position_key').on(t.seriesId, t.position),
    // Support for `rooms`' `ON DELETE SET NULL` above, which has to find every
    // referencing episode row.
    index('series_episodes_room_id_idx').on(t.roomId),
  ]
);

// ── recordings ────────────────────────────────────────────────────────────

export const recordings = pgTable(
  'recordings',
  {
    id: generatedId(),
    /**
     * NULLABLE and `SET NULL`, unlike Mongoose's `required: true` — the one
     * deliberate schema improvement in this file. See the file-level doc
     * comment for why neither CASCADE nor RESTRICT is right.
     */
    roomId: text().references(() => rooms.id, { onDelete: 'set null' }),
    /** Denormalized copy of the room's title at recording-start — not a reference. */
    roomTitle: text().notNull(),
    /** Denormalized copy of `Room.host` at recording-start. An Oxy account id. */
    host: text().notNull(),
    status: text({ enum: RECORDING_STATUSES }).notNull().default('recording'),
    /** LiveKit's own egress job id — EXTERNAL, not a Syra row. */
    egressId: text().notNull(),
    /**
     * The S3 object key for the recorded audio. Deliberately NOT in
     * `PROTECTED_COLUMNS_BY_TABLE` — see the file-level doc comment for why
     * this matches `tracks.audioSourceKey`'s existing treatment.
     */
    objectKey: text().notNull(),
    /**
     * `integer`, where Mongo stored a `Number` (a double) — a deliberate
     * narrowing to the house convention, matching `user_uploads.sizeBytes`
     * (`creators.ts:311`) and `image_assets.byteSize` (`catalog.ts:228`). The
     * ceiling is 2.1 GB, which a single room's recorded audio does not
     * approach (24 h of Opus at 64 kbps is roughly 700 MB). Recorded as a
     * choice rather than left to look like an oversight.
     */
    fileSize: integer(),
    /** `integer` for the same reason; 24 h is 86.4 M ms, well inside the range. */
    durationMs: integer(),
    startedAt: timestamptz().notNull(),
    stoppedAt: timestamptz(),
    access: text({ enum: RECORDING_ACCESS_LEVELS }).notNull().default('public'),
    /**
     * Snapshot of `Room.participants` at recording-stop time, not a live join.
     * The ONE array in this file queried by element — see the file-level doc
     * comment and the GIN index below.
     */
    participantIds: text().array().notNull().default(sql`array[]::text[]`),
    /** Written on every row, read by nothing — see the file-level doc comment. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('recordings_status_check', sql`${t.status} in (${sql.raw(inList(RECORDING_STATUSES))})`),
    check('recordings_access_check', sql`${t.access} in (${sql.raw(inList(RECORDING_ACCESS_LEVELS))})`),
    check('recordings_file_size_check', sql`${t.fileSize} is null or ${t.fileSize} >= 0`),
    check('recordings_duration_ms_check', sql`${t.durationMs} is null or ${t.durationMs} >= 0`),
    // `Recording.findOne({ egressId })` — the LiveKit egress webhook's only
    // lookup key (`routes/rooms.routes.ts:867`).
    unique('recordings_egress_id_key').on(t.egressId),
    // The public recordings listing, both sorts (`routes/recordings.routes.ts:24,32`).
    index('recordings_ready_public_created_at_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.status} = 'ready' and ${t.access} = 'public'`),
    /**
     * The top-hosts aggregate (`routes/rooms.routes.ts:1128`), which matches
     * `status: 'ready'` ALONE — no `access` filter — and groups by host. The
     * partial index above cannot serve it (it is narrower), and Mongo's
     * `{ host, status, createdAt }` was built for a `find({ host })` that has
     * no call site. This indexes the query that exists.
     */
    index('recordings_ready_host_idx').on(t.host).where(sql`${t.status} = 'ready'`),
    /**
     * The per-room listing (`routes/rooms.routes.ts:2714`), and the `ON DELETE
     * SET NULL` support index for `room_id`.
     *
     * MUST STAY NON-PARTIAL. The listing it serves always filters
     * `status: 'ready'`, so a `WHERE status = 'ready'` predicate would look
     * free — but this index is also what the `ON DELETE SET NULL` on
     * `room_id` uses to find every referencing recording, and a room being
     * deleted has recordings in every status. Narrowing it would silently
     * turn each room deletion into a sequential scan of the whole table.
     * `__tests__/gates.test.ts` asserts the DEFINITION, not just the name —
     * the name is identical either way.
     */
    index('recordings_room_id_status_created_at_idx').on(t.roomId, t.status, t.createdAt.desc()),
    // `{ access: 'participants', participantIds: userId }` — the containment
    // half of the same per-room listing. See the file-level doc comment.
    index('recordings_participant_ids_gin').using('gin', t.participantIds),
  ]
);

// ── room_user_preferences (one row per user — the "live" presence badge) ───

export const roomUserPreferences = pgTable(
  'room_user_preferences',
  {
    id: generatedId(),
    /**
     * An Oxy account id — no foreign key. Renamed from Mongo's `userId` for
     * the same reason as `house_members.oxyUserId`; see that column.
     */
    oxyUserId: text().notNull(),
    liveVisibility: text({ enum: LIVE_VISIBILITIES }).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'room_user_preferences_live_visibility_check',
      sql`${t.liveVisibility} in (${sql.raw(inList(LIVE_VISIBILITIES))})`
    ),
    // One row per account — a direct port of Mongo's unique `userId`, and the
    // index the batched `{ userId: { $in: [...] } }` read
    // (`routes/rooms.routes.ts:1228`) needs. No separate standalone index is
    // added; an index dropped in writing, per Task 2's convention.
    unique('room_user_preferences_oxy_user_id_key').on(t.oxyUserId),
  ]
);
