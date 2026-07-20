import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { clear, connect, disconnect } from '../test/mongo';
import House, { HouseMemberRole, HouseVisibility } from '../models/House';
import Room, { OwnerType, RoomStatus, RoomType } from '../models/Room';
import Series, { RecurrenceType } from '../models/Series';
import housesRoutes from './houses.routes';
import seriesRoutes from './series.routes';

/**
 * Route-level enforcement of {@link HouseVisibility}.
 *
 * These go through the real router rather than calling the model methods
 * directly, because the bug being fixed was never a wrong predicate — the
 * predicate simply was not called: `GET /houses/:id/rooms` checked only that
 * the house existed, so any authenticated user could enumerate a private
 * house's rooms. Only a request through the router proves the gate is wired.
 *
 * Each level is exercised against all three caller kinds: a member, an
 * authenticated non-member, and an unauthenticated caller.
 */

const OWNER_ID = 'owner-1';
const MEMBER_ID = 'member-1';
/** Authenticated, but in none of the houses under test. */
const OUTSIDER_ID = 'outsider-1';

/** Appears only inside a house's rooms — must never reach a barred caller. */
const SECRET_ROOM_TITLE = 'Strategy sync (members only)';
/** Appears only inside a house's series — same. */
const SECRET_SERIES_TITLE = 'Weekly members standup';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

/** A house at `visibility` with an owner and one plain member. */
async function houseAt(visibility: HouseVisibility) {
  return House.create({
    name: `${visibility} house`,
    createdBy: OWNER_ID,
    visibility,
    members: [
      { userId: OWNER_ID, role: HouseMemberRole.OWNER, joinedAt: new Date() },
      { userId: MEMBER_ID, role: HouseMemberRole.MEMBER, joinedAt: new Date() },
    ],
  });
}

/** A scheduled room owned by `houseId`, carrying the secret title. */
async function roomIn(houseId: string) {
  return Room.create({
    title: SECRET_ROOM_TITLE,
    host: OWNER_ID,
    ownerType: OwnerType.HOUSE,
    houseId,
    type: RoomType.TALK,
    status: RoomStatus.LIVE,
  });
}

/** An active series owned by `houseId` (or by a profile when omitted). */
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
 * then close. Passing `undefined` attaches no session at all, standing in for
 * an unauthenticated caller — the handler must still refuse rather than lean on
 * the `oxy.auth()` mount in server.ts being present.
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

/** GET `path` on the houses router as `actingUserId`. */
async function getHouses(path: string, actingUserId: string | undefined) {
  let result = { status: 0, body: '' };
  await withRouter('/api/houses', housesRoutes, actingUserId, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/houses${path}`);
    result = { status: response.status, body: await response.text() };
  });
  return result;
}

/** GET `path` on the series router as `actingUserId`. */
async function getSeries(path: string, actingUserId: string | undefined) {
  let result = { status: 0, body: '' };
  await withRouter('/api/series', seriesRoutes, actingUserId, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/series${path}`);
    result = { status: response.status, body: await response.text() };
  });
  return result;
}

describe('GET /api/houses/:id/rooms', () => {
  it('serves a public house to a member, a non-member and an anonymous caller', async () => {
    const house = await houseAt(HouseVisibility.PUBLIC);
    await roomIn(house._id.toString());
    const path = `/${house._id.toString()}/rooms`;

    for (const caller of [MEMBER_ID, OUTSIDER_ID, undefined]) {
      const { status, body } = await getHouses(path, caller);
      expect(status).toBe(200);
      // Proves the room really is in the payload, so the 403/404 cases below
      // are not passing merely because the house has no rooms.
      expect(body).toContain(SECRET_ROOM_TITLE);
    }
  });

  it('hides an invite-only house\'s rooms from non-members without hiding the house', async () => {
    const house = await houseAt(HouseVisibility.INVITE_ONLY);
    await roomIn(house._id.toString());
    const path = `/${house._id.toString()}/rooms`;

    const member = await getHouses(path, MEMBER_ID);
    expect(member.status).toBe(200);
    expect(member.body).toContain(SECRET_ROOM_TITLE);

    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getHouses(path, caller);
      // 403 not 404: an invite-only house is allowed to be known to exist.
      expect(status).toBe(403);
      expect(body).not.toContain(SECRET_ROOM_TITLE);
    }
  });

  it('denies a private house\'s existence to non-members', async () => {
    const house = await houseAt(HouseVisibility.PRIVATE);
    await roomIn(house._id.toString());
    const path = `/${house._id.toString()}/rooms`;

    const member = await getHouses(path, MEMBER_ID);
    expect(member.status).toBe(200);
    expect(member.body).toContain(SECRET_ROOM_TITLE);

    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getHouses(path, caller);
      // 404 not 403: a 403 would confirm the house id is real.
      expect(status).toBe(404);
      expect(body).not.toContain(SECRET_ROOM_TITLE);
    }
  });
});

describe('GET /api/houses/:id', () => {
  it('returns a public house, roster included, to every caller', async () => {
    const house = await houseAt(HouseVisibility.PUBLIC);
    const path = `/${house._id.toString()}`;

    for (const caller of [MEMBER_ID, OUTSIDER_ID, undefined]) {
      const { status, body } = await getHouses(path, caller);
      expect(status).toBe(200);
      expect(body).toContain(MEMBER_ID);
    }
  });

  it('returns an invite-only house without its roster to non-members', async () => {
    const house = await houseAt(HouseVisibility.INVITE_ONLY);
    const path = `/${house._id.toString()}`;

    const member = await getHouses(path, MEMBER_ID);
    expect(member.status).toBe(200);
    expect(member.body).toContain(MEMBER_ID);

    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getHouses(path, caller);
      expect(status).toBe(200);
      expect(body).toContain('invite_only house');
      // The house is visible; who is in it is not.
      expect(body).not.toContain(MEMBER_ID);
      expect(body).not.toContain('"members"');
      expect(body).toContain('memberCount');
      // ...except the owner, kept as attribution so a stranger knows who to
      // ask for an invite. See serializeHouseFor.
      expect(body).toContain(`"createdBy":"${OWNER_ID}"`);
    }
  });

  it('404s a private house for non-members and serves it to members', async () => {
    const house = await houseAt(HouseVisibility.PRIVATE);
    const path = `/${house._id.toString()}`;

    const member = await getHouses(path, MEMBER_ID);
    expect(member.status).toBe(200);
    expect(member.body).toContain('private house');

    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getHouses(path, caller);
      expect(status).toBe(404);
      expect(body).not.toContain('private house');
    }
  });
});

describe('GET /api/houses (discovery)', () => {
  it('lists public and invite-only houses but never a private one to a non-member', async () => {
    await houseAt(HouseVisibility.PUBLIC);
    await houseAt(HouseVisibility.INVITE_ONLY);
    await houseAt(HouseVisibility.PRIVATE);

    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getHouses('/', caller);
      expect(status).toBe(200);
      expect(body).toContain('public house');
      expect(body).toContain('invite_only house');
      expect(body).not.toContain('private house');
    }
  });

  it('lists a member\'s own private house back to them', async () => {
    await houseAt(HouseVisibility.PRIVATE);

    const { status, body } = await getHouses('/', MEMBER_ID);
    expect(status).toBe(200);
    expect(body).toContain('private house');
  });
});

describe('GET /api/houses/:id/series', () => {
  it('gates a house\'s series exactly like its rooms', async () => {
    const publicHouse = await houseAt(HouseVisibility.PUBLIC);
    await seriesIn(publicHouse._id.toString());
    const publicResult = await getHouses(`/${publicHouse._id.toString()}/series`, OUTSIDER_ID);
    expect(publicResult.status).toBe(200);
    expect(publicResult.body).toContain(SECRET_SERIES_TITLE);

    const inviteHouse = await houseAt(HouseVisibility.INVITE_ONLY);
    await seriesIn(inviteHouse._id.toString());
    const invitePath = `/${inviteHouse._id.toString()}/series`;
    const inviteMember = await getHouses(invitePath, MEMBER_ID);
    expect(inviteMember.status).toBe(200);
    expect(inviteMember.body).toContain(SECRET_SERIES_TITLE);
    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getHouses(invitePath, caller);
      expect(status).toBe(403);
      expect(body).not.toContain(SECRET_SERIES_TITLE);
    }

    const privateHouse = await houseAt(HouseVisibility.PRIVATE);
    await seriesIn(privateHouse._id.toString());
    const privatePath = `/${privateHouse._id.toString()}/series`;
    const privateMember = await getHouses(privatePath, MEMBER_ID);
    expect(privateMember.status).toBe(200);
    expect(privateMember.body).toContain(SECRET_SERIES_TITLE);
    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getHouses(privatePath, caller);
      expect(status).toBe(404);
      expect(body).not.toContain(SECRET_SERIES_TITLE);
    }
  });
});

describe('GET /api/series/:id', () => {
  it('inherits the owning house\'s visibility', async () => {
    const inviteHouse = await houseAt(HouseVisibility.INVITE_ONLY);
    const inviteSeries = await seriesIn(inviteHouse._id.toString());
    const invitePath = `/${inviteSeries._id.toString()}`;
    expect((await getSeries(invitePath, MEMBER_ID)).status).toBe(200);
    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getSeries(invitePath, caller);
      expect(status).toBe(403);
      expect(body).not.toContain(SECRET_SERIES_TITLE);
    }

    const privateHouse = await houseAt(HouseVisibility.PRIVATE);
    const privateSeries = await seriesIn(privateHouse._id.toString());
    const privatePath = `/${privateSeries._id.toString()}`;
    expect((await getSeries(privatePath, MEMBER_ID)).status).toBe(200);
    for (const caller of [OUTSIDER_ID, undefined]) {
      const { status, body } = await getSeries(privatePath, caller);
      expect(status).toBe(404);
      expect(body).not.toContain(SECRET_SERIES_TITLE);
    }
  });

  it('leaves a profile-owned series ungated', async () => {
    const series = await seriesIn();

    const { status, body } = await getSeries(`/${series._id.toString()}`, OUTSIDER_ID);
    expect(status).toBe(200);
    expect(body).toContain(SECRET_SERIES_TITLE);
  });
});

describe('house visibility writes', () => {
  it('defaults a new house to public and rejects an unrecognised level', async () => {
    const created = await House.create({ name: 'Defaulted', createdBy: OWNER_ID });
    expect(created.visibility).toBe(HouseVisibility.PUBLIC);

    const house = await houseAt(HouseVisibility.PUBLIC);
    await withRouter('/api/houses', housesRoutes, OWNER_ID, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/houses/${house._id.toString()}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'semi-public' }),
      });
      expect(response.status).toBe(400);
    });

    // The rejected write must not have silently downgraded anything.
    const unchanged = await House.findById(house._id);
    expect(unchanged?.visibility).toBe(HouseVisibility.PUBLIC);
  });

  it('lets an admin change the level and applies it immediately to room listing', async () => {
    const house = await houseAt(HouseVisibility.PUBLIC);
    await roomIn(house._id.toString());
    const roomsPath = `/${house._id.toString()}/rooms`;

    expect((await getHouses(roomsPath, OUTSIDER_ID)).status).toBe(200);

    await withRouter('/api/houses', housesRoutes, OWNER_ID, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/houses/${house._id.toString()}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: HouseVisibility.PRIVATE }),
      });
      expect(response.status).toBe(200);
    });

    const after = await getHouses(roomsPath, OUTSIDER_ID);
    expect(after.status).toBe(404);
    expect(after.body).not.toContain(SECRET_ROOM_TITLE);
  });
});
