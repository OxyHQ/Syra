import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import {
  addHouseMember,
  canAccessRooms,
  canSeeHouse,
  createHouse,
  findHouseWithMembers,
  getMemberRole,
  houseIdsWithRoomsHiddenFrom,
  isMember,
} from '../db/rooms/houses';
import { createRoom } from '../db/rooms/rooms';
import { createSeries } from '../db/rooms/series';
import {
  DEFAULT_HOUSE_VISIBILITY,
  HouseDiscovery,
  HouseJoin,
  HouseMemberRole,
  HouseRooms,
  OwnerType,
  RecurrenceType,
  RoomStatus,
  RoomType,
  SpeakerPermission,
  type HouseVisibility,
} from '../db/rooms/types';
import housesRoutes from './houses.routes';
import seriesRoutes from './series.routes';
import roomsRoutes from './rooms.routes';

/**
 * Route-level enforcement of the three visibility axes (discovery / rooms /
 * join). These go through the real routers rather than calling the model
 * methods directly, because the class of bug being guarded against was never a
 * wrong predicate — it was a predicate that simply wasn't called. Only a
 * request through the router proves the gate is wired.
 *
 * The axes are exercised independently: the required `{listed, members}` case
 * proves discovery and rooms move separately (the house is findable but its
 * rooms are sealed), and `{hidden, ...}` proves discovery wins over rooms.
 */

const OWNER_ID = 'owner-1';
const MEMBER_ID = 'member-1';
/** Authenticated, but in none of the houses under test. */
const OUTSIDER_ID = 'outsider-1';

const SECRET_ROOM_TITLE = 'Strategy sync (members only)';
const SECRET_SERIES_TITLE = 'Weekly members standup';
/** A room owned by a profile, which no house axis may ever hide. */
const PROFILE_ROOM_TITLE = 'Open profile room';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/**
 * A house at the given axes (missing axes take the defaults), with an owner and
 * one plain member.
 *
 * The roster is a child table now, so the owner arrives with the house — one
 * transaction inside `createHouse` — and the plain member is a second insert.
 */
async function houseWith(visibility: Partial<HouseVisibility>) {
  const { house } = await createHouse({
    name: `${visibility.discovery ?? 'listed'}/${visibility.rooms ?? 'anyone'}/${visibility.join ?? 'invite'} house`,
    createdBy: OWNER_ID,
    visibility: { ...DEFAULT_HOUSE_VISIBILITY, ...visibility },
    tags: [],
  });
  await addHouseMember(house.id, MEMBER_ID, HouseMemberRole.MEMBER);
  return house;
}

/** A live room owned by `houseId`, carrying the secret title. */
async function roomIn(houseId: string) {
  return createRoom({
    title: SECRET_ROOM_TITLE,
    host: OWNER_ID,
    ownerType: OwnerType.HOUSE,
    houseId,
    type: RoomType.TALK,
    status: RoomStatus.LIVE,
    participants: [],
    speakers: [OWNER_ID],
    maxParticipants: 100,
    tags: [],
    speakerPermission: SpeakerPermission.INVITED,
  });
}

/** A live room owned by a profile rather than a house. */
async function profileRoom() {
  return createRoom({
    title: PROFILE_ROOM_TITLE,
    host: OWNER_ID,
    ownerType: OwnerType.PROFILE,
    type: RoomType.TALK,
    status: RoomStatus.LIVE,
    participants: [],
    speakers: [OWNER_ID],
    maxParticipants: 100,
    tags: [],
    speakerPermission: SpeakerPermission.INVITED,
  });
}

/** An active series owned by `houseId` (or a profile when omitted). */
async function seriesIn(houseId?: string) {
  return createSeries({
    title: SECRET_SERIES_TITLE,
    houseId: houseId ?? null,
    createdBy: OWNER_ID,
    recurrence: { type: RecurrenceType.WEEKLY, time: '18:00', timezone: 'UTC' },
    roomTemplate: {
      titlePattern: 'Episode {n}',
      type: RoomType.TALK,
      maxParticipants: 100,
      speakerPermission: SpeakerPermission.INVITED,
      tags: [],
    },
  });
}

/** The house and its roster, or a hard failure — every caller needs both. */
async function loadHouse(id: string) {
  const found = await findHouseWithMembers(id);
  if (found === undefined) throw new Error('house vanished mid-test');
  return found;
}

/**
 * Serve `router` on an ephemeral port acting as `actingUserId`, run `exercise`,
 * then close. `undefined` attaches no session at all — the unauthenticated case,
 * where the handler must refuse on its own rather than lean on `oxy.auth()`
 * being mounted upstream in server.ts.
 */
async function withRouter(
  mountPath: string,
  router: express.Router,
  actingUserId: string | undefined,
  exercise: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actingUserId !== undefined) {
      (req as AuthRequest).user = { id: actingUserId };
    }
    next();
  });
  app.use(mountPath, router);

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });

  try {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected the test server to bind a TCP port');
    }
    await exercise(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

type Result = { status: number; body: string };

async function request(
  mountPath: string,
  router: express.Router,
  path: string,
  actingUserId: string | undefined,
  init?: { method?: string; json?: unknown },
): Promise<Result> {
  let result: Result = { status: 0, body: '' };
  await withRouter(mountPath, router, actingUserId, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${mountPath}${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.json ? { 'content-type': 'application/json' } : undefined,
      body: init?.json ? JSON.stringify(init.json) : undefined,
    });
    result = { status: response.status, body: await response.text() };
  });
  return result;
}

const getHouses = (path: string, user: string | undefined) =>
  request('/api/houses', housesRoutes, path, user);
const getSeries = (path: string, user: string | undefined) =>
  request('/api/series', seriesRoutes, path, user);
const getRooms = (path: string, user: string | undefined) =>
  request('/api/rooms', roomsRoutes, path, user);

describe('discovery axis — GET /api/houses/:id (see the house exists)', () => {
  it('listed: readable by member, non-member and anonymous', async () => {
    const house = await houseWith({ discovery: HouseDiscovery.LISTED });
    for (const caller of [MEMBER_ID, OUTSIDER_ID, undefined]) {
      expect((await getHouses(`/${house.id}`, caller)).status).toBe(200);
    }
  });

  it('unlisted: readable by id for everyone, but absent from the listing for a non-member', async () => {
    const house = await houseWith({ discovery: HouseDiscovery.UNLISTED });
    for (const caller of [OUTSIDER_ID, undefined]) {
      expect((await getHouses(`/${house.id}`, caller)).status).toBe(200);
      // Reachable by id, but not discoverable in the listing.
      expect((await getHouses('/', caller)).body).not.toContain(house.name);
    }
  });

  it('hidden: 404 to non-members and anonymous, 200 to a member', async () => {
    const house = await houseWith({ discovery: HouseDiscovery.HIDDEN });
    expect((await getHouses(`/${house.id}`, MEMBER_ID)).status).toBe(200);
    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getHouses(`/${house.id}`, caller);
      // 404 not 403 — a 403 would confirm a guessed id is real.
      expect(status).toBe(404);
      expect(body).not.toContain(house.name);
    }
  });
});

describe('discovery axis — GET /api/houses (listing)', () => {
  it('lists only `listed` houses to a non-member, plus that member\'s own hidden/unlisted', async () => {
    await houseWith({ discovery: HouseDiscovery.LISTED });
    await houseWith({ discovery: HouseDiscovery.UNLISTED });
    await houseWith({ discovery: HouseDiscovery.HIDDEN });

    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getHouses('/', caller);
      expect(status).toBe(200);
      expect(body).toContain('listed/anyone/invite house');
      expect(body).not.toContain('unlisted/anyone/invite house');
      expect(body).not.toContain('hidden/anyone/invite house');
    }

    // A member finds their own non-listed houses in the listing.
    const asMember = await getHouses('/', MEMBER_ID);
    expect(asMember.body).toContain('unlisted/anyone/invite house');
    expect(asMember.body).toContain('hidden/anyone/invite house');
  });
});

describe('rooms axis — GET /api/houses/:id/rooms and /series', () => {
  it('anyone: lists rooms and series to everyone', async () => {
    const house = await houseWith({ rooms: HouseRooms.ANYONE });
    const id = house.id;
    await roomIn(id);
    await seriesIn(id);

    for (const caller of [MEMBER_ID, OUTSIDER_ID, undefined]) {
      const rooms = await getHouses(`/${id}/rooms`, caller);
      expect(rooms.status).toBe(200);
      expect(rooms.body).toContain(SECRET_ROOM_TITLE);
      const series = await getHouses(`/${id}/series`, caller);
      expect(series.status).toBe(200);
      expect(series.body).toContain(SECRET_SERIES_TITLE);
    }
  });

  it('members: 200 for a member, 403 for a non-member — independently of discovery', async () => {
    // The required combo: LISTED discovery (findable) but MEMBERS rooms (sealed).
    const house = await houseWith({ discovery: HouseDiscovery.LISTED, rooms: HouseRooms.MEMBERS });
    const id = house.id;
    await roomIn(id);
    await seriesIn(id);

    // Discovery is independent: the house itself is readable by a non-member...
    expect((await getHouses(`/${id}`, OUTSIDER_ID)).status).toBe(200);

    const member = await getHouses(`/${id}/rooms`, MEMBER_ID);
    expect(member.status).toBe(200);
    expect(member.body).toContain(SECRET_ROOM_TITLE);

    for (const caller of [OUTSIDER_ID, undefined]) {
      // ...but its rooms and series are sealed: 403, not 404 — the house is
      // known to exist, the caller just isn't in it.
      const rooms = await getHouses(`/${id}/rooms`, caller);
      expect(rooms.status).toBe(403);
      expect(rooms.body).not.toContain(SECRET_ROOM_TITLE);
      const series = await getHouses(`/${id}/series`, caller);
      expect(series.status).toBe(403);
      expect(series.body).not.toContain(SECRET_SERIES_TITLE);
    }
  });

  it('hidden wins over rooms: a hidden house 404s its rooms even to a non-member', async () => {
    const house = await houseWith({ discovery: HouseDiscovery.HIDDEN, rooms: HouseRooms.ANYONE });
    const id = house.id;
    await roomIn(id);

    expect((await getHouses(`/${id}/rooms`, MEMBER_ID)).status).toBe(200);
    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getHouses(`/${id}/rooms`, caller);
      // 404, not the 403 a discoverable sealed house would give.
      expect(status).toBe(404);
      expect(body).not.toContain(SECRET_ROOM_TITLE);
    }
  });
});

/**
 * The GLOBAL room listing has to honour the same `rooms` axis as the
 * house-scoped one above, because both hand back the same documents.
 *
 * The house-scoped route was gated and this one was not, which made
 * `GET /api/rooms?houseId=<sealed>` an exact bypass of the 403 that
 * `GET /api/houses/:id/rooms` returns for the very same query — and the
 * unfiltered listing leaked sealed rooms into everyone's feed besides. What
 * leaks is what the gate on the house-scoped route exists to protect: the room
 * title, its host, and its participant ids.
 *
 * Entry was never affected — `POST /api/rooms/:id/join` has always refused a
 * non-member — so this is a confidentiality gap, not an access-control one.
 */
describe('rooms axis — GET /api/rooms (global listing)', () => {
  it('omits a sealed house\'s room, for a non-member and anonymous alike', async () => {
    const sealed = await houseWith({ discovery: HouseDiscovery.LISTED, rooms: HouseRooms.MEMBERS });
    await roomIn(sealed.id);

    // A member still sees it — the fix withholds, it does not blanket-hide.
    const member = await getRooms('/', MEMBER_ID);
    expect(member.status).toBe(200);
    expect(member.body).toContain(SECRET_ROOM_TITLE);

    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getRooms('/', caller);
      expect(status).toBe(200);
      expect(body).not.toContain(SECRET_ROOM_TITLE);
      // The host id is as sensitive as the title, and travels on the same doc.
      expect(body).not.toContain(OWNER_ID);
    }
  });

  it('omits a hidden house\'s room even when its rooms axis is open', async () => {
    const hidden = await houseWith({ discovery: HouseDiscovery.HIDDEN, rooms: HouseRooms.ANYONE });
    await roomIn(hidden.id);

    expect((await getRooms('/', MEMBER_ID)).body).toContain(SECRET_ROOM_TITLE);
    for (const caller of [OUTSIDER_ID, undefined]) {
      // discovery wins over rooms here exactly as it does on the house route.
      expect((await getRooms('/', caller)).body).not.toContain(SECRET_ROOM_TITLE);
    }
  });

  it('?houseId= cannot enumerate a sealed house\'s rooms', async () => {
    const sealed = await houseWith({ rooms: HouseRooms.MEMBERS });
    const id = sealed.id;
    await roomIn(id);

    for (const caller of [OUTSIDER_ID, undefined]) {
      // The house-scoped route answers 403 for this exact query; the global one
      // must not become a way around it.
      expect((await getHouses(`/${id}/rooms`, caller)).status).toBe(403);
      const { status, body } = await getRooms(`/?houseId=${id}`, caller);
      expect(status).toBe(200);
      expect(body).not.toContain(SECRET_ROOM_TITLE);
    }
  });

  it('keeps open-house and profile-owned rooms listed for everyone', async () => {
    const open = await houseWith({ rooms: HouseRooms.ANYONE });
    await roomIn(open.id);
    await profileRoom();

    for (const caller of [MEMBER_ID, OUTSIDER_ID, undefined]) {
      const { status, body } = await getRooms('/', caller);
      expect(status).toBe(200);
      // Both kinds survive: the filter must not over-reach into rooms that were
      // never house-owned, which is the way a visibility fix usually breaks.
      expect(body).toContain(SECRET_ROOM_TITLE);
      expect(body).toContain(PROFILE_ROOM_TITLE);
    }
  });
});

describe('rooms axis — GET /api/rooms/:id (fetch one by id)', () => {
  it('sealed house: 403 to a non-member, 200 to a member', async () => {
    const sealed = await houseWith({ discovery: HouseDiscovery.LISTED, rooms: HouseRooms.MEMBERS });
    const room = await roomIn(sealed.id);
    const path = `/${room.id}`;

    expect((await getRooms(path, MEMBER_ID)).status).toBe(200);
    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getRooms(path, caller);
      expect(status).toBe(403);
      expect(body).not.toContain(SECRET_ROOM_TITLE);
    }
  });

  it('hidden house: 404 to a non-member, so a guessed room id is never confirmed', async () => {
    const hidden = await houseWith({ discovery: HouseDiscovery.HIDDEN, rooms: HouseRooms.ANYONE });
    const room = await roomIn(hidden.id);
    const path = `/${room.id}`;

    expect((await getRooms(path, MEMBER_ID)).status).toBe(200);
    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getRooms(path, caller);
      // 404, matching a room that does not exist at all.
      expect(status).toBe(404);
      expect(body).not.toContain(SECRET_ROOM_TITLE);
    }
  });

  it('profile-owned room stays fetchable by anyone', async () => {
    const room = await profileRoom();
    const { status, body } = await getRooms(`/${room.id}`, undefined);
    expect(status).toBe(200);
    expect(body).toContain(PROFILE_ROOM_TITLE);
  });
});

/**
 * `houseIdsWithRoomsHiddenFrom` restates `canSeeHouse() && canAccessRooms()` as
 * a SQL filter. Two expressions of one rule drift, so this walks every
 * combination of the two governing axes against all three caller kinds and
 * asserts they agree — which is the only thing keeping the global listing and
 * the house-scoped route from diverging as the axes grow.
 *
 * The predicates are plain functions over `(house, members, userId)` now rather
 * than Mongoose instance methods, so this compares two pure expressions against
 * one query. What it pins is unchanged.
 */
describe('rooms axis — the query filter agrees with the predicates', () => {
  it('matches canSeeHouse && canAccessRooms on every axis combination', async () => {
    const houses = [];
    for (const discovery of Object.values(HouseDiscovery)) {
      for (const rooms of Object.values(HouseRooms)) {
        houses.push({ discovery, rooms, house: await houseWith({ discovery, rooms }) });
      }
    }
    // A vacuity floor: a traversal that silently produced nothing would
    // otherwise pass every assertion below.
    expect(houses.length).toBe(6);

    for (const caller of [MEMBER_ID, OUTSIDER_ID, undefined]) {
      const hidden = new Set(await houseIdsWithRoomsHiddenFrom(caller));

      for (const { discovery, rooms, house } of houses) {
        const fresh = await loadHouse(house.id);

        const predicatesAllow =
          canSeeHouse(fresh.house, fresh.members, caller) &&
          canAccessRooms(fresh.house, fresh.members, caller);
        const filterAllows = !hidden.has(house.id);

        expect(`${discovery}/${rooms} as ${caller ?? 'anonymous'} → ${filterAllows}`)
          .toBe(`${discovery}/${rooms} as ${caller ?? 'anonymous'} → ${predicatesAllow}`);
      }
    }
  });
});

describe('rooms axis — GET /api/series/:id inherits the owning house', () => {
  it('sealed house series 403 a non-member; profile series stay open', async () => {
    const sealed = await houseWith({ rooms: HouseRooms.MEMBERS });
    const houseSeries = await seriesIn(sealed.id);
    const seriesPath = `/${houseSeries.id}`;
    expect((await getSeries(seriesPath, MEMBER_ID)).status).toBe(200);
    for (const caller of [OUTSIDER_ID, undefined]) {
      expect((await getSeries(seriesPath, caller)).status).toBe(403);
    }

    const profileSeries = await seriesIn();
    const open = await getSeries(`/${profileSeries.id}`, OUTSIDER_ID);
    expect(open.status).toBe(200);
    expect(open.body).toContain(SECRET_SERIES_TITLE);
  });
});

describe('rooms axis — member roster in serialization', () => {
  it('withholds the roster from a non-member of a sealed house, keeping owner + count', async () => {
    const house = await houseWith({ discovery: HouseDiscovery.LISTED, rooms: HouseRooms.MEMBERS });
    const { status, body } = await getHouses(`/${house.id}`, OUTSIDER_ID);
    expect(status).toBe(200);
    // Parse rather than substring-match: the string "members" also appears as
    // the `rooms` axis value, so a naive body.contains would false-positive.
    const parsed = JSON.parse(body) as { house: Record<string, unknown> };
    expect(parsed.house.members).toBeUndefined();
    expect(parsed.house.memberCount).toBe(2);
    // createdBy survives as attribution — who to ask for an invite.
    expect(parsed.house.createdBy).toBe(OWNER_ID);
    expect(body).not.toContain(MEMBER_ID);
  });

  it('shows the full roster on an open house', async () => {
    const house = await houseWith({ rooms: HouseRooms.ANYONE });
    const body = (await getHouses(`/${house.id}`, OUTSIDER_ID)).body;
    expect(body).toContain(MEMBER_ID);
  });
});

describe('join axis — POST /api/houses/:id/join', () => {
  it('anyone: a non-member self-joins, and a second attempt is rejected', async () => {
    const house = await houseWith({ join: HouseJoin.ANYONE });
    const id = house.id;

    const joined = await request('/api/houses', housesRoutes, `/${id}/join`, OUTSIDER_ID, { method: 'POST' });
    expect(joined.status).toBe(200);

    // Persisted as a real MEMBER.
    const after = await loadHouse(id);
    expect(isMember(after.members, OUTSIDER_ID)).toBe(true);
    expect(getMemberRole(after.members, OUTSIDER_ID)).toBe(HouseMemberRole.MEMBER);

    const again = await request('/api/houses', housesRoutes, `/${id}/join`, OUTSIDER_ID, { method: 'POST' });
    expect(again.status).toBe(400);
  });

  it('invite: a non-member is refused with 403', async () => {
    const house = await houseWith({ join: HouseJoin.INVITE });
    const result = await request('/api/houses', housesRoutes, `/${house.id}/join`, OUTSIDER_ID, { method: 'POST' });
    expect(result.status).toBe(403);
    const after = await loadHouse(house.id);
    expect(isMember(after.members, OUTSIDER_ID)).toBe(false);
  });

  it('hidden + anyone: a stranger 404s (cannot join what they cannot see)', async () => {
    const house = await houseWith({ discovery: HouseDiscovery.HIDDEN, join: HouseJoin.ANYONE });
    const result = await request('/api/houses', housesRoutes, `/${house.id}/join`, OUTSIDER_ID, { method: 'POST' });
    expect(result.status).toBe(404);
    const after = await loadHouse(house.id);
    expect(isMember(after.members, OUTSIDER_ID)).toBe(false);
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const house = await houseWith({ join: HouseJoin.ANYONE });
    const result = await request('/api/houses', housesRoutes, `/${house.id}/join`, undefined, { method: 'POST' });
    expect(result.status).toBe(401);
  });
});

describe('room-entry gate — POST /api/rooms/:id/join inherits the house rooms axis', () => {
  it('sealed house: a non-member is refused, a member is admitted', async () => {
    const house = await houseWith({ rooms: HouseRooms.MEMBERS });
    const room = await roomIn(house.id);
    const roomPath = `/${room.id}/join`;

    const outsider = await request('/api/rooms', roomsRoutes, roomPath, OUTSIDER_ID, { method: 'POST' });
    expect(outsider.status).toBe(403);

    const member = await request('/api/rooms', roomsRoutes, roomPath, MEMBER_ID, { method: 'POST' });
    expect(member.status).toBe(200);
    expect(member.body).toContain('Joined room successfully');
  });

  it('open house: a non-member may enter', async () => {
    const house = await houseWith({ rooms: HouseRooms.ANYONE });
    const room = await roomIn(house.id);
    const result = await request('/api/rooms', roomsRoutes, `/${room.id}/join`, OUTSIDER_ID, { method: 'POST' });
    expect(result.status).toBe(200);
  });
});

describe('visibility writes — POST and PATCH /api/houses', () => {
  it('defaults a new house to listed/anyone/invite', async () => {
    const { house: created } = await createHouse({
      name: 'Defaulted',
      createdBy: OWNER_ID,
      visibility: DEFAULT_HOUSE_VISIBILITY,
      tags: [],
    });
    expect(created.visibilityDiscovery).toBe(HouseDiscovery.LISTED);
    expect(created.visibilityRooms).toBe(HouseRooms.ANYONE);
    expect(created.visibilityJoin).toBe(HouseJoin.INVITE);
  });

  it('rejects an unrecognised axis value with 400 without mutating the house', async () => {
    const house = await houseWith({ rooms: HouseRooms.ANYONE });
    const result = await request('/api/houses', housesRoutes, `/${house.id}`, OWNER_ID, {
      method: 'PATCH',
      json: { visibility: { rooms: 'semi-open' } },
    });
    expect(result.status).toBe(400);
    const after = await loadHouse(house.id);
    expect(after.house.visibilityRooms).toBe(HouseRooms.ANYONE);
  });

  it('PATCH changes one axis and leaves the others intact, applying immediately', async () => {
    const house = await houseWith({ discovery: HouseDiscovery.LISTED, rooms: HouseRooms.ANYONE });
    const id = house.id;
    await roomIn(id);

    // Rooms listing is open beforehand.
    expect((await getHouses(`/${id}/rooms`, OUTSIDER_ID)).status).toBe(200);

    const patched = await request('/api/houses', housesRoutes, `/${id}`, OWNER_ID, {
      method: 'PATCH',
      json: { visibility: { rooms: HouseRooms.MEMBERS } },
    });
    expect(patched.status).toBe(200);

    const after = await loadHouse(id);
    // Only rooms changed; discovery/join untouched.
    expect(after.house.visibilityRooms).toBe(HouseRooms.MEMBERS);
    expect(after.house.visibilityDiscovery).toBe(HouseDiscovery.LISTED);
    expect(after.house.visibilityJoin).toBe(HouseJoin.INVITE);

    // And the sealed rooms are now 403 to a non-member (house still discoverable).
    expect((await getHouses(`/${id}`, OUTSIDER_ID)).status).toBe(200);
    expect((await getHouses(`/${id}/rooms`, OUTSIDER_ID)).status).toBe(403);
  });
});
