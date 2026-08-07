/**
 * `houses` and `house_members` — row access, the visibility predicates, and
 * their query-level twin.
 *
 * ## The predicates are pure functions now, and that is the point
 *
 * `models/House.ts` carried `hasRole` / `getMemberRole` / `isMember` /
 * `canSeeHouse` / `canAccessRooms` / `isSelfJoinable` as Mongoose INSTANCE
 * METHODS, which meant every caller had to hold a hydrated document — the reason
 * `GET /api/houses` could not use `.lean()` and said so in a comment. They are
 * plain functions over `(house, members, userId)` here, so a caller passes rows
 * and nothing is hydrated at all.
 *
 * ## Two expressions of one rule, still pinned together
 *
 * {@link houseIdsWithRoomsHiddenFrom} is the QUERY-level twin of
 * `canSeeHouse(u) && canAccessRooms(u)` — the same rule as a filter rather than
 * a per-document predicate, because the global room listing has to withhold
 * rooms across many houses at once and cannot load each owning house to ask.
 * `routes/houseVisibility.test.ts` asserts the two agree on every combination of
 * the axes, for a member, a non-member and an anonymous caller.
 *
 * The Mongo version's "a house that predates the `visibility` field matches
 * neither restricted branch and so stays listed" caveat is GONE and deliberately
 * not reproduced: all three axis columns are `notNull` with defaults, so there is
 * no such row to reason about. The behaviour is unchanged for every house that
 * ever existed — the default IS `listed`/`anyone` — but the branch that used to
 * express it would now be dead code, and a comment describing a row shape the
 * schema forbids is worse than no comment.
 */

import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { descNullsLast } from '../catalog/containers';
import { getDb, type DbOrTransaction } from '../postgres';
import { HOUSE_DISCOVERY_LEVELS, houseMembers, houses } from '../schema/rooms';
import {
  HouseDiscovery,
  HouseJoin,
  HouseMemberRole,
  HouseRooms,
  type HouseVisibility,
} from './types';

/**
 * A `houses` row as every caller sees it.
 *
 * `search_vector` is excluded at the TYPE level, not merely left out of the
 * projection: it is a generated column carrying `name` + `description` over
 * again, nothing reads it, and the house serializer SPREADS its input — so a
 * type that admitted it would ship a `tsvector` to every client the first time
 * somebody wrote `select()` instead of naming columns.
 */
export type HouseRow = Omit<typeof houses.$inferSelect, 'searchVector'>;

/** A `house_members` row — one membership. */
export type HouseMemberRow = typeof houseMembers.$inferSelect;

/** A house together with its roster, which every permission check needs. */
export interface HouseWithMembers {
  readonly house: HouseRow;
  readonly members: readonly HouseMemberRow[];
}

/** The projection {@link HouseRow} describes — every column but the vector. */
const HOUSE_COLUMNS = {
  id: houses.id,
  name: houses.name,
  description: houses.description,
  avatar: houses.avatar,
  coverImage: houses.coverImage,
  createdBy: houses.createdBy,
  visibilityDiscovery: houses.visibilityDiscovery,
  visibilityRooms: houses.visibilityRooms,
  visibilityJoin: houses.visibilityJoin,
  tags: houses.tags,
  createdAt: houses.createdAt,
  updatedAt: houses.updatedAt,
} as const;

// ── Predicates ────────────────────────────────────────────────────────────

/** Role hierarchy: owner > admin > host > member. */
const ROLE_RANK: Record<HouseMemberRole, number> = {
  [HouseMemberRole.MEMBER]: 0,
  [HouseMemberRole.HOST]: 1,
  [HouseMemberRole.ADMIN]: 2,
  [HouseMemberRole.OWNER]: 3,
};

/** The caller's membership row, or `undefined`. */
export function findMember(
  members: readonly HouseMemberRow[],
  userId: string | undefined,
): HouseMemberRow | undefined {
  if (userId === undefined) return undefined;
  return members.find((member) => member.oxyUserId === userId);
}

/** Whether `userId` holds `minRole` or higher. */
export function hasRole(
  members: readonly HouseMemberRow[],
  userId: string | undefined,
  minRole: HouseMemberRole,
): boolean {
  const member = findMember(members, userId);
  if (!member) return false;
  return ROLE_RANK[member.role] >= ROLE_RANK[minRole];
}

/** A member's role, or `null`. */
export function getMemberRole(
  members: readonly HouseMemberRow[],
  userId: string | undefined,
): HouseMemberRole | null {
  return (findMember(members, userId)?.role as HouseMemberRole | undefined) ?? null;
}

/** Whether `userId` is a member at any role. */
export function isMember(
  members: readonly HouseMemberRow[],
  userId: string | undefined,
): boolean {
  return findMember(members, userId) !== undefined;
}

/** Whether `userId` may create rooms in this house (host, admin, or owner). */
export function canCreateRoom(
  members: readonly HouseMemberRow[],
  userId: string | undefined,
): boolean {
  return hasRole(members, userId, HouseMemberRole.HOST);
}

/**
 * Capability (a) — the `discovery` axis. May this user know the house exists?
 *
 * Only `hidden` withholds existence. A caller who fails this check must get 404,
 * never 403 — see {@link HouseDiscovery}.
 */
export function canSeeHouse(
  house: Pick<HouseRow, 'visibilityDiscovery'>,
  members: readonly HouseMemberRow[],
  userId: string | undefined,
): boolean {
  if (house.visibilityDiscovery !== HouseDiscovery.HIDDEN) return true;
  return isMember(members, userId);
}

/**
 * Capabilities (b) and (c) — the `rooms` axis. May this user list the house's
 * rooms and series, and enter a room in it?
 *
 * Listing and entering share one rule per axis value, so they share one
 * function. The caller chooses the failure code: 404 when {@link canSeeHouse}
 * also fails, 403 when it does not.
 */
export function canAccessRooms(
  house: Pick<HouseRow, 'visibilityRooms'>,
  members: readonly HouseMemberRow[],
  userId: string | undefined,
): boolean {
  if (house.visibilityRooms === HouseRooms.ANYONE) return true;
  return isMember(members, userId);
}

/**
 * Capability (d) — the `join` axis. Does this house allow self-service joining?
 *
 * A house-level policy, independent of who is asking. The endpoint still gates
 * `canSeeHouse` (404) and already-a-member (400) around this; a `hidden` house is
 * therefore never self-joinable by a stranger, because they 404 before reaching
 * the join policy.
 */
export function isSelfJoinable(house: Pick<HouseRow, 'visibilityJoin'>): boolean {
  return house.visibilityJoin === HouseJoin.ANYONE;
}

/** The three axis columns read back as one object. */
export function visibilityOf(
  house: Pick<HouseRow, 'visibilityDiscovery' | 'visibilityRooms' | 'visibilityJoin'>,
): HouseVisibility {
  return {
    discovery: house.visibilityDiscovery as HouseDiscovery,
    rooms: house.visibilityRooms as HouseRooms,
    join: house.visibilityJoin as HouseJoin,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** One house by id, without its roster. */
export async function findHouseById(
  id: string,
  db: DbOrTransaction = getDb(),
): Promise<HouseRow | undefined> {
  const [house] = await db.select(HOUSE_COLUMNS).from(houses).where(eq(houses.id, id)).limit(1);
  return house;
}

/** Every membership of one house, oldest first — the roster's natural order. */
export async function findHouseMembers(
  houseId: string,
  db: DbOrTransaction = getDb(),
): Promise<HouseMemberRow[]> {
  return db
    .select()
    .from(houseMembers)
    .where(eq(houseMembers.houseId, houseId))
    .orderBy(houseMembers.joinedAt, houseMembers.id);
}

/**
 * One house and its roster — the read behind every house-scoped permission
 * check.
 *
 * Two round trips rather than a join: a join repeats every house column once per
 * member, and the roster is read in full by the predicates anyway. Both queries
 * are point lookups on an index.
 */
export async function findHouseWithMembers(
  id: string,
  db: DbOrTransaction = getDb(),
): Promise<HouseWithMembers | undefined> {
  const house = await findHouseById(id, db);
  if (!house) return undefined;
  return { house, members: await findHouseMembers(id, db) };
}

/** Rosters for many houses at once, grouped by house id. */
export async function findMembersByHouseIds(
  houseIds: readonly string[],
  db: DbOrTransaction = getDb(),
): Promise<Map<string, HouseMemberRow[]>> {
  const grouped = new Map<string, HouseMemberRow[]>();
  if (houseIds.length === 0) return grouped;

  const rows = await db
    .select()
    .from(houseMembers)
    .where(inArray(houseMembers.houseId, [...houseIds]))
    .orderBy(houseMembers.joinedAt, houseMembers.id);

  for (const row of rows) {
    const existing = grouped.get(row.houseId);
    if (existing) existing.push(row);
    else grouped.set(row.houseId, [row]);
  }
  return grouped;
}

export interface ListHousesOptions {
  /** The caller, whose own houses are visible to them whatever their axes. */
  readonly userId: string | undefined;
  /** Exclusive upper bound on `id` — the previous page's last id. */
  readonly cursor?: string;
  /** Full-text search over name + description. */
  readonly search?: string;
  readonly limit: number;
}

/**
 * Discovery levels that put a house in the public listing — every level that is
 * not one of the two which hide it.
 *
 * DERIVED from the closed tuple rather than written as `['listed']`, so the
 * rule stays "these two withhold" (Mongo's `$nin`, and what the axis actually
 * means) while the QUERY gets an equality it can index. Add a fourth visible
 * level to `HOUSE_DISCOVERY_LEVELS` and it appears here automatically; add a
 * fourth hiding one and it must be named below, which is a change to the rule
 * and should be.
 */
const DISCOVERABLE_LEVELS = HOUSE_DISCOVERY_LEVELS.filter(
  (level) => level !== HouseDiscovery.UNLISTED && level !== HouseDiscovery.HIDDEN
);

/** Every house id `oxyUserId` belongs to, read through `house_members_oxy_user_id_idx`. */
export async function houseIdsForMember(
  oxyUserId: string,
  db: DbOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ houseId: houseMembers.houseId })
    .from(houseMembers)
    .where(eq(houseMembers.oxyUserId, oxyUserId));
  return rows.map((row) => row.houseId);
}

/**
 * The WHERE clause of the house listing, as a value the probe can read.
 *
 * Separated from {@link listHouses} for one reason: the first version of this
 * query was a Seq Scan in production and the EXPLAIN probe said it was fine,
 * because the probe was hand-transcribed SQL that happened to describe the
 * ANONYMOUS caller. `GET /api/houses` is mounted behind `oxy.auth()`
 * (`server.ts:353`, required), so a viewer is ALWAYS resolved and the
 * membership arm ALWAYS applies — the arm the probe did not have. Exporting the
 * conditions lets `__tests__/rooms.explain.test.ts` build its probe from the
 * shipped predicate instead of a paraphrase of it, so the two cannot describe
 * different queries again.
 *
 * `memberHouseIds` is resolved by the caller rather than expressed inline; see
 * {@link listHouses} for why.
 */
export function houseListingConditions(options: {
  readonly memberHouseIds: readonly string[];
  readonly cursor?: string;
  readonly search?: string;
}): SQL {
  const visible: SQL[] = [inArray(houses.visibilityDiscovery, [...DISCOVERABLE_LEVELS])];
  if (options.memberHouseIds.length > 0) {
    visible.push(inArray(houses.id, [...options.memberHouseIds]));
  }

  const conditions: SQL[] = [or(...visible) as SQL];
  if (options.cursor !== undefined) {
    conditions.push(sql`${houses.id} < ${options.cursor}`);
  }
  if (options.search !== undefined && options.search.length > 0) {
    // Replaces Mongo's `$text` over the `{ name: 'text', description: 'text' }`
    // index; `houses.searchVector` is the generated `tsvector` behind
    // `houses_search_gin`.
    conditions.push(sql`${houses.searchVector} @@ plainto_tsquery('english', ${options.search})`);
  }

  return and(...conditions) as SQL;
}

/**
 * The discoverable house listing, newest first.
 *
 * Returns every `listed` house, plus any house the caller is a member of —
 * which is how a member still finds their own `unlisted` or `hidden` houses.
 * Membership comes from the server-resolved session, never the request.
 *
 * ## Why this is `IN` and not `NOT IN`
 *
 * `visibility_discovery NOT IN ('unlisted', 'hidden')` renders as `<> ALL(...)`,
 * which Postgres cannot use a btree for AT ALL — measured under
 * `enable_seqscan = off`, it sequential-scans `houses` and then top-N sorts,
 * making `houses_visibility_discovery_created_at_idx` dead weight on the one
 * query it was built for. The two spellings are equivalent because the axis is
 * a CLOSED set of three with a CHECK enforcing it — but Postgres cannot know
 * that, which is why the complement is computed in TypeScript from the same
 * tuple the CHECK is derived from.
 *
 * ## Why membership is TWO queries and not a correlated `EXISTS`
 *
 * `exists (select 1 from house_members where house_id = houses.id and …)` reads
 * naturally and is the direct transcription of Mongo's `'members.userId': userId`
 * — and it is a **Seq Scan**, because an `OR` between a column predicate and a
 * correlated subquery gives the planner no index it can combine. That is not a
 * rare path: this route is mounted behind required auth, so it is the ONLY path.
 *
 * Resolving the member's house ids first turns the second arm into `id = ANY(…)`,
 * which the planner combines with the discovery index as a `BitmapOr`. Measured
 * on 30,000 houses with the probed member in 2,869 of them:
 *
 * | shape | plan | time |
 * |---|---|---|
 * | `EXISTS` (this, before) | **Seq Scan** + top-N sort | 88.7 ms |
 * | `id = ANY` (this, now) | BitmapOr of two indexes | 8.9 ms |
 * | `UNION` with a per-arm `LIMIT` | Index Scan, stops at 21 | 5.9 ms |
 *
 * The `UNION` is faster still because each arm's own `LIMIT` lets the ordered
 * index short-circuit, and it is deliberately NOT taken: it has to duplicate the
 * cursor and search predicates into both arms and carries `UNION`'s dedupe, for
 * 3 ms on a synthetic table far larger than Syra's. Recorded so the number is
 * here if that ever stops being true.
 *
 * The extra round trip is one indexed read of `house_members` (0.24 ms at that
 * size) and is the same "resolve ids, then filter" shape
 * {@link houseIdsWithRoomsHiddenFrom} and `listRooms`' `excludeHouseIds` already
 * use in this vertical.
 */
export async function listHouses(
  options: ListHousesOptions,
  db: DbOrTransaction = getDb(),
): Promise<HouseRow[]> {
  const memberHouseIds =
    options.userId === undefined ? [] : await houseIdsForMember(options.userId, db);

  const conditions = houseListingConditions({
    memberHouseIds,
    cursor: options.cursor,
    search: options.search,
  });

  return db
    .select(HOUSE_COLUMNS)
    .from(houses)
    .where(conditions)
    .orderBy(descNullsLast(houses.createdAt))
    .limit(options.limit);
}

/**
 * The ids of houses whose rooms `userId` must NOT be shown — the query-level
 * twin of `canSeeHouse(userId) && canAccessRooms(userId)`.
 *
 * A member is restricted by neither axis, so their own houses drop out of the
 * exclusion set; an anonymous caller is a member of nothing.
 */
export async function houseIdsWithRoomsHiddenFrom(
  userId: string | undefined,
  db: DbOrTransaction = getDb(),
): Promise<string[]> {
  const restricted: SQL[] = [
    or(
      eq(houses.visibilityDiscovery, HouseDiscovery.HIDDEN),
      eq(houses.visibilityRooms, HouseRooms.MEMBERS)
    ) as SQL,
  ];

  if (userId !== undefined) {
    restricted.push(
      sql`not exists (select 1 from ${houseMembers}
                      where ${houseMembers.houseId} = ${houses.id}
                        and ${houseMembers.oxyUserId} = ${userId})`
    );
  }

  const rows = await db
    .select({ id: houses.id })
    .from(houses)
    .where(and(...restricted));

  return rows.map((row) => row.id);
}

// ── Writes ────────────────────────────────────────────────────────────────

export interface CreateHouseInput {
  readonly name: string;
  readonly description?: string | null;
  readonly avatar?: string | null;
  readonly coverImage?: string | null;
  readonly createdBy: string;
  readonly visibility: HouseVisibility;
  readonly tags: string[];
}

/**
 * Create a house with its creator as `owner`, in one transaction.
 *
 * The roster is a second table now, so "a house always has an owner" stops being
 * a property of one document and becomes a property of two writes — which is
 * exactly why they share a transaction rather than running in sequence.
 */
export async function createHouse(
  input: CreateHouseInput,
  db: DbOrTransaction = getDb(),
): Promise<HouseWithMembers> {
  return db.transaction(async (tx) => {
    const [house] = await tx
      .insert(houses)
      .values({
        name: input.name,
        description: input.description ?? null,
        avatar: input.avatar ?? null,
        coverImage: input.coverImage ?? null,
        createdBy: input.createdBy,
        visibilityDiscovery: input.visibility.discovery,
        visibilityRooms: input.visibility.rooms,
        visibilityJoin: input.visibility.join,
        tags: input.tags,
      })
      .returning(HOUSE_COLUMNS);

    const members = await tx
      .insert(houseMembers)
      .values({
        houseId: house.id,
        oxyUserId: input.createdBy,
        role: HouseMemberRole.OWNER,
      })
      .returning();

    return { house, members };
  });
}

/**
 * Fields a house PATCH may change.
 *
 * `null` CLEARS and `undefined` LEAVES ALONE — drizzle's `buildUpdateSet` drops
 * every `undefined`-valued key, where Mongoose's `save()` issued `$unset` for
 * the same assignment. Callers that mean "clear this" must pass `null`; the
 * route's `description ? trim : undefined` shape is the exact spelling that
 * shipped as a live bug twice in earlier verticals.
 */
export type UpdateHouseInput = Partial<{
  name: string;
  description: string | null;
  avatar: string | null;
  coverImage: string | null;
  tags: string[];
  visibility: HouseVisibility;
}>;

export async function updateHouse(
  id: string,
  input: UpdateHouseInput,
  db: DbOrTransaction = getDb(),
): Promise<HouseRow | undefined> {
  const [updated] = await db
    .update(houses)
    .set({
      name: input.name,
      description: input.description,
      avatar: input.avatar,
      coverImage: input.coverImage,
      tags: input.tags,
      visibilityDiscovery: input.visibility?.discovery,
      visibilityRooms: input.visibility?.rooms,
      visibilityJoin: input.visibility?.join,
      updatedAt: new Date(),
    })
    .where(eq(houses.id, id))
    .returning(HOUSE_COLUMNS);

  return updated;
}

/** Set one axis. Used by the moderation restrict/restore path. */
export async function setHouseDiscovery(
  id: string,
  discovery: HouseDiscovery,
  db: DbOrTransaction = getDb(),
): Promise<boolean> {
  const updated = await db
    .update(houses)
    .set({ visibilityDiscovery: discovery, updatedAt: new Date() })
    .where(eq(houses.id, id))
    .returning({ id: houses.id });

  return updated.length > 0;
}

/**
 * Delete a house. Its members go with it (`ON DELETE CASCADE`); its rooms and
 * series are left with `house_id = null` (`ON DELETE SET NULL`) — see
 * `schema/rooms.ts` on `rooms.house_id` for why that state is deliberate and
 * what it leaves open.
 */
export async function deleteHouse(id: string, db: DbOrTransaction = getDb()): Promise<boolean> {
  const deleted = await db.delete(houses).where(eq(houses.id, id)).returning({ id: houses.id });
  return deleted.length > 0;
}

/** Add one membership. The unique `(house_id, oxy_user_id)` makes it a set. */
export async function addHouseMember(
  houseId: string,
  oxyUserId: string,
  role: HouseMemberRole,
  db: DbOrTransaction = getDb(),
): Promise<HouseMemberRow> {
  const [member] = await db
    .insert(houseMembers)
    .values({ houseId, oxyUserId, role })
    .returning();
  return member;
}

export async function updateHouseMemberRole(
  houseId: string,
  oxyUserId: string,
  role: HouseMemberRole,
  db: DbOrTransaction = getDb(),
): Promise<boolean> {
  const updated = await db
    .update(houseMembers)
    .set({ role })
    .where(and(eq(houseMembers.houseId, houseId), eq(houseMembers.oxyUserId, oxyUserId)))
    .returning({ id: houseMembers.id });

  return updated.length > 0;
}

export async function removeHouseMember(
  houseId: string,
  oxyUserId: string,
  db: DbOrTransaction = getDb(),
): Promise<boolean> {
  const deleted = await db
    .delete(houseMembers)
    .where(and(eq(houseMembers.houseId, houseId), eq(houseMembers.oxyUserId, oxyUserId)))
    .returning({ id: houseMembers.id });

  return deleted.length > 0;
}
