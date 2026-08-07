/**
 * `rooms` and `room_media_queue_items` — row access for the live vertical.
 *
 * ## Four columns this module refuses to hand out by accident
 *
 * `rtmpStreamKey`, `rtmpUrl`, `activeStreamUrl` and `activeIngressId` are
 * registered in `PROTECTED_COLUMNS_BY_TABLE`, so {@link ROOM_PUBLIC_COLUMNS} —
 * built by `publicColumns(rooms, …)` — omits them at the TYPE level: a
 * serializer that reaches for one fails `tsc` rather than shipping a live RTMP
 * PUBLISHING key. Two paths legitimately need them — the room manager's own view,
 * and the ingress teardown paths that must read the id they are deleting — and
 * both go through {@link findRoomById}, which is the ONE read in this module
 * that returns them. Everything client-facing uses {@link findPublicRoomById} or
 * {@link listRooms}, both of which project {@link ROOM_PUBLIC_COLUMNS}.
 *
 * ## `undefined` leaves alone; `null` clears
 *
 * Every "stop the stream" path in `rooms.routes.ts` used to assign `undefined`
 * to nine fields and call `save()`, which Mongoose turned into `$unset`.
 * Drizzle's `buildUpdateSet` DROPS an `undefined`-valued key, so the identical
 * code against Postgres is a stop that stops nothing — the stale RTMP key, the
 * stale ingress id and the stale "now playing" card all survive.
 * {@link CLEARED_STREAM_FIELDS} is therefore an explicit all-`null` object
 * rather than a loop over the same field names, and {@link stopRoomStreamFields}
 * is the single place the teardown paths go through.
 *
 * ## The queue is a table, so the queue write is a transaction
 *
 * `Room.podcastQueue[]` is `room_media_queue_items`. Replacing a queue is a
 * DELETE plus an INSERT, and the stream paths only persist the remainder once
 * the ingress actually started — so {@link replaceRoomStreamAndQueue} takes both
 * halves and writes them in ONE transaction, preserving the Mongo behaviour that
 * a failed start leaves the persisted queue untouched.
 */

import { and, asc, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { descNullsLast } from '../catalog/containers';
import { publicColumns } from '@oxyhq/db/assert';
import { getDb, type DbOrTransaction } from '../postgres';
import { PROTECTED_COLUMNS_BY_TABLE } from '../schema/protectedColumns';
import { roomMediaQueueItems, rooms } from '../schema/rooms';
import {
  BroadcastKind,
  OwnerType,
  RoomStatus,
  RoomType,
  SpeakerPermission,
  type MediaQueueItem,
} from './types';

/** Every `rooms` column a client-facing path may see. */
export const ROOM_PUBLIC_COLUMNS = publicColumns(rooms, PROTECTED_COLUMNS_BY_TABLE);

/** A room as a client-facing path sees it — the four credentials absent. */
export type RoomRow = {
  -readonly [K in keyof typeof ROOM_PUBLIC_COLUMNS]: typeof rooms.$inferSelect[K];
};

/**
 * The four credential columns, named explicitly.
 *
 * `findImplicitWholeRowReads` REFUSES a bare `db.select().from(rooms)` — that is
 * the second, independent guard `PROTECTED_COLUMNS_BY_TABLE` buys, and it fired
 * on the first draft of this module. A read that legitimately needs a protected
 * column has to name it, which is the point: the two reads below are then the
 * only places in the codebase where these four appear, and `grep` finds them.
 */
const ROOM_CREDENTIAL_COLUMNS = {
  activeIngressId: rooms.activeIngressId,
  activeStreamUrl: rooms.activeStreamUrl,
  rtmpUrl: rooms.rtmpUrl,
  rtmpStreamKey: rooms.rtmpStreamKey,
} as const;

/** Every column, public and protected — the manager/teardown projection. */
const ROOM_ALL_COLUMNS = { ...ROOM_PUBLIC_COLUMNS, ...ROOM_CREDENTIAL_COLUMNS } as const;

/**
 * A room INCLUDING its internal stream credentials.
 *
 * Held only by a manager-scoped read or an ingress teardown path. Never returned
 * to a client without going through `stripInternalStreamFields`.
 */
export type RoomWithCredentials = typeof rooms.$inferSelect;

/** One queued media item, with the columns the queue actually carries. */
export type RoomMediaQueueRow = typeof roomMediaQueueItems.$inferSelect;

/** The room fields `canManageRoom` needs — nothing more. */
export type RoomOwnershipFields = Pick<RoomRow, 'host' | 'ownerType' | 'houseId'>;

// ── Reads ─────────────────────────────────────────────────────────────────

/**
 * One room by id, credentials INCLUDED.
 *
 * The stream routes all need `activeIngressId` (to delete the ingress they are
 * replacing) and the manager view needs all four, so this is the read the write
 * paths use. Client-facing readers use {@link findPublicRoomById}.
 */
export async function findRoomById(
  id: string,
  db: DbOrTransaction = getDb(),
): Promise<RoomWithCredentials | undefined> {
  const [room] = await db.select(ROOM_ALL_COLUMNS).from(rooms).where(eq(rooms.id, id)).limit(1);
  return room;
}

/** One room by id with the four credentials withheld. */
export async function findPublicRoomById(
  id: string,
  db: DbOrTransaction = getDb(),
): Promise<RoomRow | undefined> {
  const [room] = await db.select(ROOM_PUBLIC_COLUMNS).from(rooms).where(eq(rooms.id, id)).limit(1);
  return room;
}

/** `Room.findOne({ activeIngressId })` — the LiveKit webhook's only lookup. */
export async function findRoomByIngressId(
  ingressId: string,
  db: DbOrTransaction = getDb(),
): Promise<RoomWithCredentials | undefined> {
  const [room] = await db
    .select(ROOM_ALL_COLUMNS)
    .from(rooms)
    .where(eq(rooms.activeIngressId, ingressId))
    .limit(1);
  return room;
}

export interface ListRoomsOptions {
  readonly status?: RoomStatus;
  readonly host?: string;
  readonly type?: RoomType;
  readonly ownerType?: OwnerType;
  readonly houseId?: string;
  /** House ids whose rooms this caller may not see. */
  readonly excludeHouseIds?: readonly string[];
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * The room listing — both the global one and the per-house one, which differ
 * only in whether `houseId` is set.
 *
 * `archived = false` is unconditional, matching Mongo's `archived: { $ne: true }`
 * and matching the `WHERE` clause of all five listing indexes. Absent a status
 * filter the default is the live/scheduled pair, never `ended`.
 */
export async function listRooms(
  options: ListRoomsOptions,
  db: DbOrTransaction = getDb(),
): Promise<RoomRow[]> {
  const conditions: SQL[] = [eq(rooms.archived, false)];

  conditions.push(
    options.status !== undefined
      ? eq(rooms.status, options.status)
      : inArray(rooms.status, [RoomStatus.LIVE, RoomStatus.SCHEDULED])
  );

  if (options.host !== undefined) conditions.push(eq(rooms.host, options.host));
  if (options.type !== undefined) conditions.push(eq(rooms.type, options.type));
  if (options.ownerType !== undefined) conditions.push(eq(rooms.ownerType, options.ownerType));
  if (options.houseId !== undefined) conditions.push(eq(rooms.houseId, options.houseId));

  if (options.excludeHouseIds !== undefined && options.excludeHouseIds.length > 0) {
    /**
     * A profile-owned room has `house_id = null`, and `null NOT IN (…)` is NULL
     * — not true — so a bare `notInArray` would DROP every profile-owned room
     * from the listing the moment any house became restricted. Mongo's `$nin`
     * matches a missing field, which is the behaviour being reproduced here;
     * the `isNull` arm is what reproduces it.
     */
    conditions.push(
      or(isNull(rooms.houseId), notInArray(rooms.houseId, [...options.excludeHouseIds])) as SQL
    );
  }

  if (options.cursor !== undefined) {
    conditions.push(sql`${rooms.id} < ${options.cursor}`);
  }

  return db
    .select(ROOM_PUBLIC_COLUMNS)
    .from(rooms)
    .where(and(...conditions))
    .orderBy(descNullsLast(rooms.createdAt))
    .limit(options.limit);
}

/** The minimal live-room shape the live-badge feed needs. */
export interface LiveRoomBroadcasters {
  readonly id: string;
  readonly host: string;
  readonly speakers: string[];
}

/**
 * Every currently-live room's broadcasters, for the live-badge feed.
 *
 * `archived = false` is carried DELIBERATELY, and it is a behaviour change from
 * Mongo. Two reasons, and the second is the load-bearing one:
 *
 *  1. `rooms_status_created_at_idx` is partial on `archived = false`, so a query
 *     without the predicate cannot use it and sequential-scans `rooms` on every
 *     request.
 *  2. `archived` is the MODERATION restriction lever for a room — per
 *     `moderation/enforcement-service.ts`, "the only lever a room has that does
 *     not end a live session out from under the people in it" — so an archived
 *     room is routinely `status = 'live'` at the same time. Mongo's unfiltered
 *     query therefore still emitted a live badge for a room a moderator had
 *     restricted. This closes that, rather than carrying it forward.
 */
export async function findLiveRoomBroadcasters(
  db: DbOrTransaction = getDb(),
): Promise<LiveRoomBroadcasters[]> {
  return db
    .select({ id: rooms.id, host: rooms.host, speakers: rooms.speakers })
    .from(rooms)
    .where(and(eq(rooms.status, RoomStatus.LIVE), eq(rooms.archived, false)));
}

/** A room's queued media items, in queue order. */
export async function findRoomQueue(
  roomId: string,
  db: DbOrTransaction = getDb(),
): Promise<MediaQueueItem[]> {
  const rows = await db
    .select({
      kind: roomMediaQueueItems.kind,
      syraPodcastId: roomMediaQueueItems.syraPodcastId,
      episodeId: roomMediaQueueItems.episodeId,
      trackId: roomMediaQueueItems.trackId,
    })
    .from(roomMediaQueueItems)
    .where(eq(roomMediaQueueItems.roomId, roomId))
    .orderBy(asc(roomMediaQueueItems.position));

  return rows.map(toMediaQueueItem);
}

/** Queues for many rooms at once, grouped by room id and each in queue order. */
export async function findQueuesByRoomIds(
  roomIds: readonly string[],
  db: DbOrTransaction = getDb(),
): Promise<Map<string, MediaQueueItem[]>> {
  const grouped = new Map<string, MediaQueueItem[]>();
  if (roomIds.length === 0) return grouped;

  const rows = await db
    .select({
      roomId: roomMediaQueueItems.roomId,
      kind: roomMediaQueueItems.kind,
      syraPodcastId: roomMediaQueueItems.syraPodcastId,
      episodeId: roomMediaQueueItems.episodeId,
      trackId: roomMediaQueueItems.trackId,
    })
    .from(roomMediaQueueItems)
    .where(inArray(roomMediaQueueItems.roomId, [...roomIds]))
    .orderBy(asc(roomMediaQueueItems.position));

  for (const row of rows) {
    const item = toMediaQueueItem(row);
    const existing = grouped.get(row.roomId);
    if (existing) existing.push(item);
    else grouped.set(row.roomId, [item]);
  }
  return grouped;
}

/**
 * A queue ROW back to the {@link MediaQueueItem} shape.
 *
 * The columns are nullable and the interface's fields are optional, so each null
 * is dropped rather than carried through as an explicit `undefined` — otherwise
 * a `'track'` item would serialize with `episodeId: null` where the Mongo
 * subdocument simply had no such key.
 */
function toMediaQueueItem(row: {
  kind: string;
  syraPodcastId: string | null;
  episodeId: string | null;
  trackId: string | null;
}): MediaQueueItem {
  return {
    kind: row.kind as MediaQueueItem['kind'],
    ...(row.syraPodcastId === null ? {} : { syraPodcastId: row.syraPodcastId }),
    ...(row.episodeId === null ? {} : { episodeId: row.episodeId }),
    ...(row.trackId === null ? {} : { trackId: row.trackId }),
  };
}

// ── Writes ────────────────────────────────────────────────────────────────

export interface CreateRoomInput {
  readonly title: string;
  readonly description?: string | null;
  readonly host: string;
  readonly type: RoomType;
  readonly ownerType: OwnerType;
  readonly broadcastKind?: BroadcastKind | null;
  readonly houseId?: string | null;
  readonly status: RoomStatus;
  readonly participants: string[];
  readonly speakers: string[];
  readonly maxParticipants: number;
  readonly scheduledStart?: Date | null;
  readonly topic?: string | null;
  readonly tags: string[];
  readonly speakerPermission: SpeakerPermission;
  readonly recordingEnabled?: boolean;
  readonly seriesId?: string | null;
}

export async function createRoom(
  input: CreateRoomInput,
  db: DbOrTransaction = getDb(),
): Promise<RoomWithCredentials> {
  const [room] = await db
    .insert(rooms)
    .values({
      title: input.title,
      description: input.description ?? null,
      host: input.host,
      type: input.type,
      ownerType: input.ownerType,
      broadcastKind: input.broadcastKind ?? null,
      houseId: input.houseId ?? null,
      status: input.status,
      participants: input.participants,
      speakers: input.speakers,
      maxParticipants: input.maxParticipants,
      scheduledStart: input.scheduledStart ?? null,
      topic: input.topic ?? null,
      tags: input.tags,
      speakerPermission: input.speakerPermission,
      recordingEnabled: input.recordingEnabled ?? true,
      seriesId: input.seriesId ?? null,
    })
    .returning(ROOM_ALL_COLUMNS);

  return room;
}

/**
 * Fields a room update may change. `undefined` leaves alone, `null` clears —
 * see this file's doc comment.
 */
export type UpdateRoomInput = Partial<{
  status: RoomStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  speakers: string[];
  speakerPermission: SpeakerPermission;
  participants: string[];
  statsPeakListeners: number;
  statsTotalJoined: number;
  archived: boolean;
  recordingEnabled: boolean;
  recordingEgressId: string | null;
  activeIngressId: string | null;
  activeStreamUrl: string | null;
  streamTitle: string | null;
  streamImage: string | null;
  streamDescription: string | null;
  rtmpUrl: string | null;
  rtmpStreamKey: string | null;
  streamStartedAt: Date | null;
  streamDurationSec: number | null;
}>;

export async function updateRoom(
  id: string,
  input: UpdateRoomInput,
  db: DbOrTransaction = getDb(),
): Promise<RoomWithCredentials | undefined> {
  const [room] = await db
    .update(rooms)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(rooms.id, id))
    .returning(ROOM_ALL_COLUMNS);

  return room;
}

/**
 * Every stream field at once, all `null`.
 *
 * The nine fields `clearRoomStreamFields` used to assign `undefined` to, spelled
 * as an explicit object so a teardown actually tears down — see this file's doc
 * comment for why `undefined` here would be a silent no-op. The queue is the
 * tenth field and lives in another table, so callers pair this with
 * {@link deleteRoomQueue}; {@link stopRoomStreamFields} does both.
 */
export const CLEARED_STREAM_FIELDS: UpdateRoomInput = {
  activeIngressId: null,
  activeStreamUrl: null,
  streamTitle: null,
  streamImage: null,
  streamDescription: null,
  rtmpUrl: null,
  rtmpStreamKey: null,
  streamStartedAt: null,
  streamDurationSec: null,
};

/**
 * Clear every stream field AND drain the queue, in one transaction — the
 * persistence half of "stop the stream".
 *
 * `extra` folds in a caller's own same-row changes (the `/end` route's
 * `status`/`endedAt`, the `/stop` route's reset to `scheduled`) so a stop is one
 * UPDATE rather than two, and so a room can never be observed mid-teardown with
 * its status changed but its RTMP key still live.
 */
export async function stopRoomStreamFields(
  id: string,
  extra: UpdateRoomInput = {},
  db: DbOrTransaction = getDb(),
): Promise<RoomWithCredentials | undefined> {
  return db.transaction(async (tx) => {
    await tx.delete(roomMediaQueueItems).where(eq(roomMediaQueueItems.roomId, id));
    return updateRoom(id, { ...CLEARED_STREAM_FIELDS, ...extra }, tx);
  });
}

/** Drain a room's queue. */
export async function deleteRoomQueue(
  roomId: string,
  db: DbOrTransaction = getDb(),
): Promise<void> {
  await db.delete(roomMediaQueueItems).where(eq(roomMediaQueueItems.roomId, roomId));
}

/**
 * Persist a started stream and the queue remainder ATOMICALLY.
 *
 * This is the shape that keeps the Mongo behaviour the routes depend on: the
 * remaining queue is staged in memory and written only once the ingress has
 * actually started, so a failed start leaves the persisted queue untouched and
 * the head available for a retry. Two tables, therefore one transaction.
 */
export async function replaceRoomStreamAndQueue(
  id: string,
  streamFields: UpdateRoomInput,
  queue: readonly MediaQueueItem[],
  db: DbOrTransaction = getDb(),
): Promise<RoomWithCredentials | undefined> {
  return db.transaction(async (tx) => {
    await tx.delete(roomMediaQueueItems).where(eq(roomMediaQueueItems.roomId, id));

    if (queue.length > 0) {
      await tx.insert(roomMediaQueueItems).values(
        queue.map((item, position) => ({
          roomId: id,
          position,
          kind: item.kind,
          syraPodcastId: item.syraPodcastId ?? null,
          episodeId: item.episodeId ?? null,
          trackId: item.trackId ?? null,
        }))
      );
    }

    return updateRoom(id, streamFields, tx);
  });
}

/**
 * Add `userId` to `participants` and bump the stats, in one statement.
 *
 * The array mutations are done in SQL rather than read-modify-write because two
 * people joining the same room concurrently would otherwise each write back the
 * roster they read, losing one of the two — the socket path in particular runs
 * this on every connection. `array_append` under a `not (… = any(…))` guard is
 * Mongo's `$addToSet`; `greatest` is its `$max`.
 */
export async function addParticipant(
  roomId: string,
  userId: string,
  peakListeners: number,
  db: DbOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(rooms)
    .set({
      participants: sql`case when ${userId} = any(${rooms.participants}) then ${rooms.participants}
                             else array_append(${rooms.participants}, ${userId}) end`,
      statsTotalJoined: sql`case when ${userId} = any(${rooms.participants}) then ${rooms.statsTotalJoined}
                                 else ${rooms.statsTotalJoined} + 1 end`,
      statsPeakListeners: sql`greatest(${rooms.statsPeakListeners}, ${peakListeners})`,
      updatedAt: new Date(),
    })
    .where(eq(rooms.id, roomId));
}

/** Remove `userId` from `participants` — Mongo's `$pull`. */
export async function removeParticipant(
  roomId: string,
  userId: string,
  db: DbOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(rooms)
    .set({
      participants: sql`array_remove(${rooms.participants}, ${userId})`,
      updatedAt: new Date(),
    })
    .where(eq(rooms.id, roomId));
}

/** Add `userId` to `speakers` if absent — Mongo's `$addToSet`. */
export async function addSpeaker(
  roomId: string,
  userId: string,
  db: DbOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(rooms)
    .set({
      speakers: sql`case when ${userId} = any(${rooms.speakers}) then ${rooms.speakers}
                        else array_append(${rooms.speakers}, ${userId}) end`,
      updatedAt: new Date(),
    })
    .where(eq(rooms.id, roomId));
}

/** Remove `userId` from `speakers` — Mongo's `$pull`. */
export async function removeSpeaker(
  roomId: string,
  userId: string,
  db: DbOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(rooms)
    .set({
      speakers: sql`array_remove(${rooms.speakers}, ${userId})`,
      updatedAt: new Date(),
    })
    .where(eq(rooms.id, roomId));
}

/** Set `archived`. Used by the moderation restrict/restore path. */
export async function setRoomArchived(
  id: string,
  archived: boolean,
  db: DbOrTransaction = getDb(),
): Promise<boolean> {
  const updated = await db
    .update(rooms)
    .set({ archived, updatedAt: new Date() })
    .where(eq(rooms.id, id))
    .returning({ id: rooms.id });

  return updated.length > 0;
}

/** Delete a room. Its queue goes with it (`ON DELETE CASCADE`). */
export async function deleteRoom(id: string, db: DbOrTransaction = getDb()): Promise<boolean> {
  const deleted = await db.delete(rooms).where(eq(rooms.id, id)).returning({ id: rooms.id });
  return deleted.length > 0;
}
