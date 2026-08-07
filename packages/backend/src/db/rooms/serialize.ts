/**
 * Response shapes for the rooms-and-live vertical.
 *
 * The routes used to return Mongoose documents directly, so the wire shape was
 * whatever the schema happened to hold. Two things about that shape do not
 * survive the port unchanged, and both are stated here rather than left to be
 * discovered from a diff:
 *
 *  - **`_id` becomes `id`.** Every ported vertical emits `id`
 *    (`@syra/shared-types`' own DTOs make `id` required and `_id` merely
 *    optional), and the `rooms`/`houses`/`series`/`recordings` primary key is
 *    literally named `id`. Emitting `_id` would mean carrying a compat alias
 *    forward for a document type that no longer exists. The three frontend call
 *    sites that read `room._id` move with this change.
 *  - **`topicId` is gone from `PUBLIC_ROOM_FIELDS`.** It named a dropped column
 *    (`schema/rooms.ts` records why: a `ref: 'Topic'` against a model this repo
 *    does not have, `undefined` on every document ever written). Keeping the
 *    entry would name a field no row can produce.
 *
 * Everything else is preserved exactly, including the two shapes that stopped
 * being stored the way they are returned: `stats` was a subdocument and is two
 * flat columns now, and `podcastQueue` was an embedded array and is a child
 * table — both are rebuilt into their original nested form below, so no client
 * sees the storage change.
 */

import type { HouseMemberRow, HouseRow } from './houses';
import { isMember } from './houses';
import type { RoomRow, RoomWithCredentials } from './rooms';
import { HouseRooms, type MediaQueueItem } from './types';

// ── rooms ─────────────────────────────────────────────────────────────────

/**
 * Room fields that are safe to return to a client.
 *
 * An allowlist, not a denylist: {@link stripInternalStreamFields} rebuilds the
 * response from these keys alone, so a column added to the schema later is
 * dropped from responses until it is listed here. That direction fails closed —
 * a new internal field can never ship to clients because nobody remembered to
 * exclude it.
 *
 * The four internal stream credentials are absent by construction, and now by a
 * second, independent mechanism as well: they are registered in
 * `PROTECTED_COLUMNS_BY_TABLE`, so {@link RoomRow} does not carry them at the
 * TYPE level and a bare `db.select().from(rooms)` is refused outright.
 */
export const PUBLIC_ROOM_FIELDS = [
  'id',
  'title',
  'description',
  'ownerType',
  'host',
  'houseId',
  'createdByAdmin',
  'type',
  'broadcastKind',
  'status',
  'scheduledStart',
  'startedAt',
  'endedAt',
  'speakerPermission',
  'participants',
  'speakers',
  'maxParticipants',
  'topic',
  'tags',
  'archived',
  'seriesId',
  'recordingEnabled',
  'recordingEgressId',
  'streamTitle',
  'streamImage',
  'streamDescription',
  'streamStartedAt',
  'streamDurationSec',
  'createdAt',
  'updatedAt',
] as const;

type PublicRoomField = (typeof PUBLIC_ROOM_FIELDS)[number];

/** The public view of a room: the allowlist, plus the two rebuilt shapes. */
export interface PublicRoom extends Partial<Record<PublicRoomField, unknown>> {
  id: string;
  stats: { peakListeners: number; totalJoined: number };
  podcastQueue?: MediaQueueItem[];
}

/**
 * Build the public view of a room, omitting the internal stream credentials.
 *
 * Reads each allowed field explicitly and returns a NEW object. The Mongo
 * predecessor's warning still applies and is why this shape is kept: an earlier
 * implementation DELETED the credential fields from its input instead, which on
 * a hydrated document was a silent no-op — schema fields were prototype getters,
 * not own properties — so a live RTMP publishing key serialized straight to the
 * client with no error and no failing test.
 *
 * Accepts a row with or without credentials: the allowlist never names one, so
 * passing a {@link RoomWithCredentials} is safe and is what the manager-scoped
 * paths do when they need to strip before responding.
 */
export function stripInternalStreamFields(
  room: RoomRow | RoomWithCredentials,
  queue?: readonly MediaQueueItem[],
): PublicRoom {
  const source = room as Partial<Record<PublicRoomField, unknown>>;
  const sanitized: Partial<Record<PublicRoomField, unknown>> = {};

  for (const field of PUBLIC_ROOM_FIELDS) {
    const value = source[field];
    if (value !== undefined) {
      sanitized[field] = value;
    }
  }

  return {
    ...sanitized,
    id: room.id,
    // `stats` was one subdocument and is two flat columns; rebuilt so the wire
    // shape is unchanged.
    stats: {
      peakListeners: room.statsPeakListeners,
      totalJoined: room.statsTotalJoined,
    },
    // Absent rather than `[]` when there is no queue, matching the Mongo field's
    // `default: undefined` — an empty array would be a new value on the wire.
    ...(queue === undefined || queue.length === 0 ? {} : { podcastQueue: [...queue] }),
  };
}

/**
 * The manager's view: every public field PLUS the four stream credentials.
 *
 * Only `GET /rooms/:id` reaches this, and only after `canManageRoom`. Written as
 * an explicit merge rather than returning the raw row so the credential set is
 * named in exactly one place and a reviewer can see what "internal" means.
 */
export function roomWithInternalStreamFields(
  room: RoomWithCredentials,
  queue?: readonly MediaQueueItem[],
): PublicRoom & {
  activeIngressId: string | null;
  activeStreamUrl: string | null;
  rtmpUrl: string | null;
  rtmpStreamKey: string | null;
} {
  return {
    ...stripInternalStreamFields(room, queue),
    activeIngressId: room.activeIngressId,
    activeStreamUrl: room.activeStreamUrl,
    rtmpUrl: room.rtmpUrl,
    rtmpStreamKey: room.rtmpStreamKey,
  };
}

// ── houses ────────────────────────────────────────────────────────────────

/** One membership as the API returns it — `userId`, not the column's name. */
export interface PublicHouseMember {
  userId: string;
  role: string;
  joinedAt: Date;
}

/**
 * The wire name stays `userId` even though the column is `oxy_user_id`.
 *
 * The rename happened in the SCHEMA, for consistency with the other 51 tables
 * that spell an Oxy account id `oxy_user_id`. Renaming it on the wire as well
 * would be a client-visible change with no reason behind it, so the serializer
 * maps back.
 */
function toPublicMember(member: HouseMemberRow): PublicHouseMember {
  return { userId: member.oxyUserId, role: member.role, joinedAt: member.joinedAt };
}

export interface PublicHouse {
  id: string;
  name: string;
  description: string | null;
  avatar: string | null;
  coverImage: string | null;
  createdBy: string;
  visibility: { discovery: string; rooms: string; join: string };
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  members?: PublicHouseMember[];
  memberCount?: number;
}

/**
 * Serialize a house for a caller who has passed `canSeeHouse`.
 *
 * The member roster names every user in the house, so it is withheld from
 * non-members whenever the house is content-sealed (`rooms: members`) — those
 * callers may know the house exists without learning who is in it. When
 * `rooms: anyone`, participants are visible in the rooms anyway, so the roster
 * adds no disclosure and is kept. `memberCount` replaces the withheld roster so
 * the UI can still show how big the house is.
 *
 * `createdBy` deliberately survives the withholding: a discoverable sealed house
 * is one you might ask to be let into, which requires knowing who owns it. It is
 * the one member id a non-member is meant to learn.
 */
export function serializeHouseFor(
  house: HouseRow,
  members: readonly HouseMemberRow[],
  userId: string | undefined,
): PublicHouse {
  const base: PublicHouse = {
    id: house.id,
    name: house.name,
    description: house.description,
    avatar: house.avatar,
    coverImage: house.coverImage,
    createdBy: house.createdBy,
    // `visibility` was one subdocument and is three flat columns; rebuilt so the
    // wire shape is unchanged.
    visibility: {
      discovery: house.visibilityDiscovery,
      rooms: house.visibilityRooms,
      join: house.visibilityJoin,
    },
    tags: house.tags,
    createdAt: house.createdAt,
    updatedAt: house.updatedAt,
  };

  const sealed = house.visibilityRooms === HouseRooms.MEMBERS;
  if (sealed && !isMember(members, userId)) {
    return { ...base, memberCount: members.length };
  }

  return { ...base, members: members.map(toPublicMember) };
}
