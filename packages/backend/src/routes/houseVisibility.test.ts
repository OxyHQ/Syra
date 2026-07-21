import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { clear, connect, disconnect } from '../test/mongo';
import House, {
  HouseDiscovery,
  HouseJoin,
  HouseMemberRole,
  HouseRooms,
  IHouseVisibility,
} from '../models/House';
import Room, { OwnerType, RoomStatus, RoomType } from '../models/Room';
import Series, { RecurrenceType } from '../models/Series';
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

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

/** A house at the given axes (missing axes take the schema defaults), with an
 * owner and one plain member. */
async function houseWith(visibility: Partial<IHouseVisibility>) {
  return House.create({
    name: `${visibility.discovery ?? 'listed'}/${visibility.rooms ?? 'anyone'}/${visibility.join ?? 'invite'} house`,
    createdBy: OWNER_ID,
    visibility,
    members: [
      { userId: OWNER_ID, role: HouseMemberRole.OWNER, joinedAt: new Date() },
      { userId: MEMBER_ID, role: HouseMemberRole.MEMBER, joinedAt: new Date() },
    ],
  });
}

/** A live room owned by `houseId`, carrying the secret title. */
async function roomIn(houseId: string) {
  return Room.create({
    title: SECRET_ROOM_TITLE,
    host: OWNER_ID,
    ownerType: OwnerType.HOUSE,
    houseId,
    type: RoomType.TALK,
    status: RoomStatus.LIVE,
    maxParticipants: 100,
  });
}

/** An active series owned by `houseId` (or a profile when omitted). */
async function seriesIn(houseId?: string) {
  return Series.create({
    title: SECRET_SERIES_TITLE,
    houseId,
    createdBy: OWNER_ID,
    recurrence: { type: RecurrenceType.WEEKLY, time: '18:00', timezone: 'UTC' },
    roomTemplate: { titlePattern: 'Episode {n}', type: RoomType.TALK },
    isActive: true,
  });
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

describe('discovery axis — GET /api/houses/:id (see the house exists)', () => {
  it('listed: readable by member, non-member and anonymous', async () => {
    const house = await houseWith({ discovery: HouseDiscovery.LISTED });
    for (const caller of [MEMBER_ID, OUTSIDER_ID, undefined]) {
      expect((await getHouses(`/${house._id.toString()}`, caller)).status).toBe(200);
    }
  });

  it('unlisted: readable by id for everyone, but absent from the listing for a non-member', async () => {
    const house = await houseWith({ discovery: HouseDiscovery.UNLISTED });
    for (const caller of [OUTSIDER_ID, undefined]) {
      expect((await getHouses(`/${house._id.toString()}`, caller)).status).toBe(200);
      // Reachable by id, but not discoverable in the listing.
      expect((await getHouses('/', caller)).body).not.toContain(house.name);
    }
  });

  it('hidden: 404 to non-members and anonymous, 200 to a member', async () => {
    const house = await houseWith({ discovery: HouseDiscovery.HIDDEN });
    expect((await getHouses(`/${house._id.toString()}`, MEMBER_ID)).status).toBe(200);
    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getHouses(`/${house._id.toString()}`, caller);
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
    const id = house._id.toString();
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
    const id = house._id.toString();
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
    const id = house._id.toString();
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

describe('rooms axis — GET /api/series/:id inherits the owning house', () => {
  it('sealed house series 403 a non-member; profile series stay open', async () => {
    const sealed = await houseWith({ rooms: HouseRooms.MEMBERS });
    const houseSeries = await seriesIn(sealed._id.toString());
    const seriesPath = `/${houseSeries._id.toString()}`;
    expect((await getSeries(seriesPath, MEMBER_ID)).status).toBe(200);
    for (const caller of [OUTSIDER_ID, undefined]) {
      expect((await getSeries(seriesPath, caller)).status).toBe(403);
    }

    const profileSeries = await seriesIn();
    const open = await getSeries(`/${profileSeries._id.toString()}`, OUTSIDER_ID);
    expect(open.status).toBe(200);
    expect(open.body).toContain(SECRET_SERIES_TITLE);
  });
});

describe('rooms axis — member roster in serialization', () => {
  it('withholds the roster from a non-member of a sealed house, keeping owner + count', async () => {
    const house = await houseWith({ discovery: HouseDiscovery.LISTED, rooms: HouseRooms.MEMBERS });
    const { status, body } = await getHouses(`/${house._id.toString()}`, OUTSIDER_ID);
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
    const body = (await getHouses(`/${house._id.toString()}`, OUTSIDER_ID)).body;
    expect(body).toContain(MEMBER_ID);
  });
});

describe('join axis — POST /api/houses/:id/join', () => {
  it('anyone: a non-member self-joins, and a second attempt is rejected', async () => {
    const house = await houseWith({ join: HouseJoin.ANYONE });
    const id = house._id.toString();

    const joined = await request('/api/houses', housesRoutes, `/${id}/join`, OUTSIDER_ID, { method: 'POST' });
    expect(joined.status).toBe(200);

    // Persisted as a real MEMBER.
    const after = await House.findById(id);
    expect(after?.isMember(OUTSIDER_ID)).toBe(true);
    expect(after?.getMemberRole(OUTSIDER_ID)).toBe(HouseMemberRole.MEMBER);

    const again = await request('/api/houses', housesRoutes, `/${id}/join`, OUTSIDER_ID, { method: 'POST' });
    expect(again.status).toBe(400);
  });

  it('invite: a non-member is refused with 403', async () => {
    const house = await houseWith({ join: HouseJoin.INVITE });
    const result = await request('/api/houses', housesRoutes, `/${house._id.toString()}/join`, OUTSIDER_ID, { method: 'POST' });
    expect(result.status).toBe(403);
    const after = await House.findById(house._id);
    expect(after?.isMember(OUTSIDER_ID)).toBe(false);
  });

  it('hidden + anyone: a stranger 404s (cannot join what they cannot see)', async () => {
    const house = await houseWith({ discovery: HouseDiscovery.HIDDEN, join: HouseJoin.ANYONE });
    const result = await request('/api/houses', housesRoutes, `/${house._id.toString()}/join`, OUTSIDER_ID, { method: 'POST' });
    expect(result.status).toBe(404);
    const after = await House.findById(house._id);
    expect(after?.isMember(OUTSIDER_ID)).toBe(false);
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const house = await houseWith({ join: HouseJoin.ANYONE });
    const result = await request('/api/houses', housesRoutes, `/${house._id.toString()}/join`, undefined, { method: 'POST' });
    expect(result.status).toBe(401);
  });
});

describe('room-entry gate — POST /api/rooms/:id/join inherits the house rooms axis', () => {
  it('sealed house: a non-member is refused, a member is admitted', async () => {
    const house = await houseWith({ rooms: HouseRooms.MEMBERS });
    const room = await roomIn(house._id.toString());
    const roomPath = `/${room._id.toString()}/join`;

    const outsider = await request('/api/rooms', roomsRoutes, roomPath, OUTSIDER_ID, { method: 'POST' });
    expect(outsider.status).toBe(403);

    const member = await request('/api/rooms', roomsRoutes, roomPath, MEMBER_ID, { method: 'POST' });
    expect(member.status).toBe(200);
    expect(member.body).toContain('Joined room successfully');
  });

  it('open house: a non-member may enter', async () => {
    const house = await houseWith({ rooms: HouseRooms.ANYONE });
    const room = await roomIn(house._id.toString());
    const result = await request('/api/rooms', roomsRoutes, `/${room._id.toString()}/join`, OUTSIDER_ID, { method: 'POST' });
    expect(result.status).toBe(200);
  });
});

describe('visibility writes — POST and PATCH /api/houses', () => {
  it('defaults a new house to listed/anyone/invite', async () => {
    const created = await House.create({ name: 'Defaulted', createdBy: OWNER_ID });
    expect(created.visibility.discovery).toBe(HouseDiscovery.LISTED);
    expect(created.visibility.rooms).toBe(HouseRooms.ANYONE);
    expect(created.visibility.join).toBe(HouseJoin.INVITE);
  });

  it('rejects an unrecognised axis value with 400 without mutating the house', async () => {
    const house = await houseWith({ rooms: HouseRooms.ANYONE });
    const result = await request('/api/houses', housesRoutes, `/${house._id.toString()}`, OWNER_ID, {
      method: 'PATCH',
      json: { visibility: { rooms: 'semi-open' } },
    });
    expect(result.status).toBe(400);
    const after = await House.findById(house._id);
    expect(after?.visibility.rooms).toBe(HouseRooms.ANYONE);
  });

  it('PATCH changes one axis and leaves the others intact, applying immediately', async () => {
    const house = await houseWith({ discovery: HouseDiscovery.LISTED, rooms: HouseRooms.ANYONE });
    const id = house._id.toString();
    await roomIn(id);

    // Rooms listing is open beforehand.
    expect((await getHouses(`/${id}/rooms`, OUTSIDER_ID)).status).toBe(200);

    const patched = await request('/api/houses', housesRoutes, `/${id}`, OWNER_ID, {
      method: 'PATCH',
      json: { visibility: { rooms: HouseRooms.MEMBERS } },
    });
    expect(patched.status).toBe(200);

    const after = await House.findById(id);
    // Only rooms changed; discovery/join untouched.
    expect(after?.visibility.rooms).toBe(HouseRooms.MEMBERS);
    expect(after?.visibility.discovery).toBe(HouseDiscovery.LISTED);
    expect(after?.visibility.join).toBe(HouseJoin.INVITE);

    // And the sealed rooms are now 403 to a non-member (house still discoverable).
    expect((await getHouses(`/${id}`, OUTSIDER_ID)).status).toBe(200);
    expect((await getHouses(`/${id}/rooms`, OUTSIDER_ID)).status).toBe(403);
  });
});
