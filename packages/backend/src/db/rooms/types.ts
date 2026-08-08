/**
 * The closed value sets and shared shapes of the rooms-and-live vertical.
 *
 * These were members of `models/{House,Room,Series,Recording,RoomUserPreference}
 * .ts` until Task 14 deleted those files. They live here rather than in
 * `@syra/shared-types` because nothing outside this backend consumes them —
 * unlike `PlaylistVisibility`, which the frontend imports, and which is why that
 * one sits in shared-types and these do not.
 *
 * ## Why enums beside the schema's `as const` tuples
 *
 * `db/schema/rooms.ts` already exports `ROOM_STATUSES`, `HOUSE_MEMBER_ROLES` and
 * nine more as `as const` tuples, and those tuples are the authority: they type
 * each column AND derive its CHECK constraint. The enums below are a SECOND
 * expression of the same value sets, kept because ~60 call sites across the nine
 * ported files read `RoomStatus.LIVE` rather than `'live'`, and because an enum
 * member is a typo that `tsc` catches at every one of them.
 *
 * Two expressions of one rule is exactly the shape that drifts, so
 * `__tests__/enumsMatchSchema.test.ts` pins each enum to its tuple by value and
 * by length. That is the same device `houseVisibility.test.ts` already applies
 * to `houseIdsWithRoomsHiddenFrom` and the visibility predicates in this very
 * vertical — add a value to one side without the other and a test fails by name.
 */

// ── house ─────────────────────────────────────────────────────────────────

export enum HouseMemberRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  HOST = 'host',
  MEMBER = 'member',
}

/**
 * House visibility as three ORTHOGONAL axes, not a single ladder.
 *
 * A flat level (public / invite-only / private) can only express three points on
 * one line. Real houses vary along three independent questions, and the axes let
 * every combination be meaningful by construction — e.g. `{ discovery: listed,
 * rooms: members }` is "anyone can find the house, but only members see what's
 * happening in it", which no single level could express.
 *
 * Capabilities, and the axis that governs each:
 *
 *   (a) see the house exists   → `discovery`
 *   (b) list its rooms/series  → `rooms`
 *   (c) enter one of its rooms → `rooms`
 *   (d) become a member        → `join`
 *
 * ── `discovery` — can this user learn the house exists? ──
 *   listed    (a) anyone; the house appears in `GET /houses`.
 *   unlisted  (a) anyone holding its id; absent from listings. Link-sharing, not
 *             secrecy — the id is the capability.
 *   hidden    (a) members only. A non-member gets 404 on EVERY house-scoped
 *             route, so the house's existence is never confirmed. 404 rather
 *             than 403 is deliberate and load-bearing: a 403 would tell a
 *             stranger that the id they guessed is real.
 *
 * ── `rooms` — can this user see and enter what's happening inside? ──
 *   anyone    (b)+(c) any caller who has cleared `discovery` may list the rooms
 *             and series and enter the rooms.
 *   members   (b)+(c) members only; a non-member gets 403 — the house is known
 *             to exist, the caller simply is not in it. The member roster is
 *             also withheld from non-members of a `members` house.
 *
 * ── `join` — how does a non-member become a member? ──
 *   anyone    (d) self-service via `POST /houses/:id/join`.
 *   invite    (d) an admin or owner adds them via `POST /houses/:id/members`.
 *   (A request-to-join flow is intentionally NOT a value here. A `request` value
 *   would need pending-request storage and approve/deny endpoints that do not
 *   exist; shipping it as a setting that silently behaved like `invite` would be
 *   a control that lies. It is deferred to its own task.)
 *
 * ── Composition ── Effective access is the STRICTEST applicable axis, evaluated
 * `discovery` then `rooms`. A `hidden` house is invisible to non-members
 * regardless of `rooms`, so `{ hidden, anyone }` behaves as `{ hidden, members }`
 * — well-defined, not forbidden, and it fails closed.
 *
 * Role ({@link HouseMemberRole}) is orthogonal to all three: it governs what a
 * *member* may DO inside the house. It never widens visibility for a non-member.
 */
export enum HouseDiscovery {
  LISTED = 'listed',
  UNLISTED = 'unlisted',
  HIDDEN = 'hidden',
}

export enum HouseRooms {
  ANYONE = 'anyone',
  MEMBERS = 'members',
}

export enum HouseJoin {
  ANYONE = 'anyone',
  INVITE = 'invite',
}

/** The three axes as one object — the shape `resolveVisibility` merges onto. */
export interface HouseVisibility {
  discovery: HouseDiscovery;
  rooms: HouseRooms;
  join: HouseJoin;
}

/**
 * Defaults for a new house, and the effective value for any house row whose
 * axes were never set explicitly. Chosen to reproduce the old `isPublic: true`
 * behaviour exactly — `join: invite` is today's only membership mechanism
 * (admin-adds), so existing behaviour is preserved with no backfill.
 *
 * The `houses` table gives all three columns these same values as column
 * DEFAULTs and marks them `notNull`, so unlike the Mongo document this is a
 * fallback for a caller that omits the field rather than for a row that lacks
 * it — a stored house always has all three.
 */
export const DEFAULT_HOUSE_VISIBILITY: HouseVisibility = {
  discovery: HouseDiscovery.LISTED,
  rooms: HouseRooms.ANYONE,
  join: HouseJoin.INVITE,
};

// ── room ──────────────────────────────────────────────────────────────────

export enum RoomStatus {
  SCHEDULED = 'scheduled',
  LIVE = 'live',
  ENDED = 'ended',
}

export enum RoomType {
  TALK = 'talk',
  STAGE = 'stage',
  BROADCAST = 'broadcast',
}

export enum OwnerType {
  PROFILE = 'profile',
  HOUSE = 'house',
  AGORA = 'agora',
}

export enum BroadcastKind {
  USER = 'user',
  AGORA = 'agora',
}

export enum SpeakerPermission {
  EVERYONE = 'everyone',
  FOLLOWERS = 'followers',
  INVITED = 'invited',
}

/** Discriminant for a queued in-room media item. */
export type MediaQueueKind = 'podcast' | 'track';

/**
 * One queued in-room media item awaiting playback after the current one — either
 * a Syra podcast episode (`kind: 'podcast'`) or a Syra music track
 * (`kind: 'track'`, the listening-party source). Only opaque ids are stored; the
 * playable audio URL is ALWAYS resolved server-side at play-time (never trusted
 * from the client).
 *
 * A single flat shape rather than a strict union, unchanged from the Mongoose
 * subdocument this replaces. Where the Mongo comment could only ASSERT that "the
 * parse/seed paths guarantee the right fields are populated for each kind", the
 * `room_media_queue_items_kind_ids_check` CHECK now enforces it — including the
 * negative half that stops a `'track'` row carrying an `episodeId`.
 *
 * For a podcast item, `syraPodcastId` (when present) is cross-checked against the
 * resolved episode's show at play-time to reject a mismatched pairing.
 */
export interface MediaQueueItem {
  kind: MediaQueueKind;
  // Podcast-episode reference (kind === 'podcast')
  syraPodcastId?: string;
  episodeId?: string;
  // Music-track reference (kind === 'track')
  trackId?: string;
}

// ── series ────────────────────────────────────────────────────────────────

export enum RecurrenceType {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  BIWEEKLY = 'biweekly',
  MONTHLY = 'monthly',
}

// ── recording ─────────────────────────────────────────────────────────────

export enum RecordingStatus {
  RECORDING = 'recording',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
  DELETED = 'deleted',
}

export enum RecordingAccess {
  PUBLIC = 'public',
  PARTICIPANTS = 'participants',
}

// ── room user preference ──────────────────────────────────────────────────

/**
 * How a user's "live" presence badge should surface across apps.
 *
 *  - `active`   — show me live whenever I host a live room (default).
 *  - `speaking` — show me live only while I'm actually an active speaker /
 *                 broadcasting, not merely hosting a live room in silence.
 */
export type LiveVisibility = 'active' | 'speaking';

export const LIVE_VISIBILITY_VALUES: readonly LiveVisibility[] = ['active', 'speaking'];

/** Applied when a user has never set a preference. */
export const DEFAULT_LIVE_VISIBILITY: LiveVisibility = 'active';

/** Runtime guard for untrusted (request-body) input. */
export function isLiveVisibility(value: unknown): value is LiveVisibility {
  return value === 'active' || value === 'speaking';
}
