/**
 * `recordings` — the recorded-audio rows for a live room.
 *
 * ## `room_id` is nullable here and was `required: true` in Mongoose
 *
 * Rooms ARE hard-deleted, with no check for existing recordings and no cleanup,
 * so a `Recording.roomId` pointing at nothing was already reachable — the
 * Mongoose `required` only ever constrained the INSERT. `ON DELETE SET NULL`
 * promotes that silent dangling reference into an explicit one. Neither
 * alternative is right: `CASCADE` would delete recorded audio because someone
 * tidied up a room, and `RESTRICT` would refuse a deletion the app performs
 * freely today.
 *
 * ## `expires_at` is written by everything and read by nothing
 *
 * Every row gets `now + 6 months` and nothing ever queries by it — there is no
 * sweeper, and the declared retention has never once been enforced. The column
 * is carried (the intent is real) and this module deliberately adds no sweep:
 * `db/expiry.ts`'s registry replaces a Mongo TTL index, and this was never one,
 * so starting to delete recordings Mongo has never deleted is a product decision
 * rather than a port.
 */

import { and, arrayContains, eq, or, sql, type SQL } from 'drizzle-orm';
import { descNullsLast } from '../catalog/containers';
import { getDb, type DbOrTransaction } from '../postgres';
import { recordings } from '../schema/rooms';
import { RecordingAccess, RecordingStatus } from './types';

export type RecordingRow = typeof recordings.$inferSelect;

// ── Reads ─────────────────────────────────────────────────────────────────

export async function findRecordingById(
  id: string,
  db: DbOrTransaction = getDb(),
): Promise<RecordingRow | undefined> {
  const [row] = await db.select().from(recordings).where(eq(recordings.id, id)).limit(1);
  return row;
}

/** `Recording.findOne({ egressId })` — the LiveKit egress webhook's lookup key. */
export async function findRecordingByEgressId(
  egressId: string,
  db: DbOrTransaction = getDb(),
): Promise<RecordingRow | undefined> {
  const [row] = await db
    .select()
    .from(recordings)
    .where(eq(recordings.egressId, egressId))
    .limit(1);
  return row;
}

/** Whether a room has any recording at all — the moderation snapshot's probe. */
export async function roomHasRecording(
  roomId: string,
  db: DbOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: recordings.id })
    .from(recordings)
    .where(eq(recordings.roomId, roomId))
    .limit(1);
  return row !== undefined;
}

export type PublicRecordingSort = 'popular' | 'recent';

/**
 * The public recordings listing.
 *
 * `popular` orders by listener count — `cardinality(participant_ids)` — which
 * replaces Mongo's `$addFields: { listenerCount: { $size: … } }` stage. The
 * count is NOT projected: the aggregation removed it again with
 * `$project: { listenerCount: 0 }`, so adding it to the response would be a new
 * field rather than a port.
 */
export async function listPublicRecordings(
  sort: PublicRecordingSort,
  limit: number,
  db: DbOrTransaction = getDb(),
): Promise<RecordingRow[]> {
  const query = db
    .select()
    .from(recordings)
    .where(
      and(
        eq(recordings.status, RecordingStatus.READY),
        eq(recordings.access, RecordingAccess.PUBLIC)
      )
    );

  return sort === 'popular'
    ? query
        .orderBy(sql`cardinality(${recordings.participantIds}) desc`, descNullsLast(recordings.createdAt))
        .limit(limit)
    : query.orderBy(descNullsLast(recordings.createdAt)).limit(limit);
}

export interface ListRoomRecordingsOptions {
  readonly roomId: string;
  /** A manager sees every ready recording; anyone else is access-filtered. */
  readonly canManage: boolean;
  readonly userId: string | undefined;
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * The per-room recordings listing, access-filtered.
 *
 * A non-manager sees public recordings plus any `participants` recording they
 * are actually in; an anonymous caller sees public ones only. `arrayContains`
 * is the containment read `recordings_participant_ids_gin` exists for.
 */
export async function listRoomRecordings(
  options: ListRoomRecordingsOptions,
  db: DbOrTransaction = getDb(),
): Promise<RecordingRow[]> {
  const conditions: SQL[] = [
    eq(recordings.roomId, options.roomId),
    eq(recordings.status, RecordingStatus.READY),
  ];

  if (!options.canManage) {
    conditions.push(
      options.userId === undefined
        ? eq(recordings.access, RecordingAccess.PUBLIC)
        : (or(
            eq(recordings.access, RecordingAccess.PUBLIC),
            and(
              eq(recordings.access, RecordingAccess.PARTICIPANTS),
              arrayContains(recordings.participantIds, [options.userId])
            )
          ) as SQL)
    );
  }

  if (options.cursor !== undefined) {
    conditions.push(sql`${recordings.id} < ${options.cursor}`);
  }

  return db
    .select()
    .from(recordings)
    .where(and(...conditions))
    .orderBy(descNullsLast(recordings.createdAt))
    .limit(options.limit);
}

export interface TopHost {
  userId: string;
  roomCount: number;
  totalListeners: number;
}

/**
 * The top-hosts aggregate — `status: 'ready'` alone, grouped by host, ordered by
 * total listeners. Served by `recordings_ready_host_idx`.
 */
export async function findTopHosts(
  limit: number,
  db: DbOrTransaction = getDb(),
): Promise<TopHost[]> {
  return db
    .select({
      userId: recordings.host,
      roomCount: sql<number>`count(*)::int`,
      totalListeners: sql<number>`coalesce(sum(cardinality(${recordings.participantIds})), 0)::int`,
    })
    .from(recordings)
    .where(eq(recordings.status, RecordingStatus.READY))
    .groupBy(recordings.host)
    .orderBy(sql`coalesce(sum(cardinality(${recordings.participantIds})), 0) desc`)
    .limit(limit);
}

// ── Writes ────────────────────────────────────────────────────────────────

export interface CreateRecordingInput {
  /**
   * Supplied by the caller, not left to the column default.
   *
   * The S3 object key embeds the recording's own id, so the id has to exist
   * BEFORE the row is written. Mongo could not do that, which is why the old
   * code inserted a placeholder row (`egressId: 'pending'`, `objectKey:
   * 'pending'`) purely to mint an `_id` and then saved twice more. Ids are
   * minted in the application here — `generatedId()` is a `$defaultFn`, not a
   * database default — so the caller derives the key first and the row is
   * written once, already correct.
   */
  readonly id: string;
  readonly roomId: string;
  readonly roomTitle: string;
  readonly host: string;
  readonly egressId: string;
  readonly objectKey: string;
  readonly startedAt: Date;
  readonly expiresAt: Date;
}

export async function createRecording(
  input: CreateRecordingInput,
  db: DbOrTransaction = getDb(),
): Promise<RecordingRow> {
  const [row] = await db
    .insert(recordings)
    .values({
      id: input.id,
      roomId: input.roomId,
      roomTitle: input.roomTitle,
      host: input.host,
      status: RecordingStatus.RECORDING,
      egressId: input.egressId,
      objectKey: input.objectKey,
      startedAt: input.startedAt,
      access: RecordingAccess.PUBLIC,
      expiresAt: input.expiresAt,
    })
    .returning();

  return row;
}

export type UpdateRecordingInput = Partial<{
  status: RecordingStatus;
  access: RecordingAccess;
  egressId: string;
  objectKey: string;
  stoppedAt: Date | null;
  durationMs: number | null;
  fileSize: number | null;
  participantIds: string[];
}>;

export async function updateRecording(
  id: string,
  input: UpdateRecordingInput,
  db: DbOrTransaction = getDb(),
): Promise<RecordingRow | undefined> {
  const [row] = await db
    .update(recordings)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(recordings.id, id))
    .returning();

  return row;
}

/**
 * Mark a still-recording row finished, in ONE statement.
 *
 * The `status = 'recording'` guard is in the WHERE clause rather than a
 * read-then-check: the manual stop, the room-ended stop and the one-hour
 * auto-stop timer can all fire for the same recording, and a read-modify-write
 * would let two of them each decide it was theirs to finish. Returning no row
 * means somebody else already did.
 *
 * `durationMs` is computed by the CALLER from the row's own `startedAt` rather
 * than in a raw `sql` template here. Interpolating a `Date` into `` sql`…` ``
 * reaches the driver unmapped — the column's `timestamptz` codec never runs —
 * so the arithmetic would depend on the driver's own guess at the value's type.
 * Every caller has already read the row to check its status, so it has
 * `startedAt` in hand and the subtraction is free.
 */
export async function finishRecording(
  id: string,
  stoppedAt: Date,
  durationMs: number,
  participantIds: string[] | undefined,
  db: DbOrTransaction = getDb(),
): Promise<RecordingRow | undefined> {
  const [row] = await db
    .update(recordings)
    .set({
      status: RecordingStatus.READY,
      stoppedAt,
      durationMs,
      participantIds,
      updatedAt: new Date(),
    })
    .where(and(eq(recordings.id, id), eq(recordings.status, RecordingStatus.RECORDING)))
    .returning();

  return row;
}
