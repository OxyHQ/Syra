import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { clear, connect, disconnect } from '../test/mongo';
import Room, { OwnerType, RoomStatus, RoomType } from '../models/Room';
import House from '../models/House';
import roomsRoutes from './rooms.routes';
import housesRoutes from './houses.routes';

/**
 * Route-level guards against leaking the LiveKit RTMP publishing credential.
 *
 * `rtmpStreamKey` lets whoever holds it broadcast INTO a room as the host, so it must
 * never reach a plain listener. These are end-to-end route tests rather than unit tests
 * on the sanitizer, because the leaks they cover were not sanitizer bugs — the sanitizer
 * was simply never called on these two paths. Only a request through the real router
 * catches that.
 */

/** The value that must never appear in a response body. */
const SECRET_STREAM_KEY = 'LK_sensitive_stream_key';
/** A plain authenticated user: not the host, not a room manager, not a house member. */
const LISTENER_ID = 'listener-not-the-host';
const HOST_ID = 'host-1';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

/** Fields that put a room in the exact state where a live RTMP key exists. */
function liveRoomWithCredentials(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Live room',
    host: HOST_ID,
    ownerType: OwnerType.PROFILE,
    type: RoomType.BROADCAST,
    status: RoomStatus.LIVE,
    activeIngressId: 'ingress-1',
    activeStreamUrl: 'https://example.com/source.m3u8',
    rtmpUrl: 'rtmp://livekit.example/live',
    rtmpStreamKey: SECRET_STREAM_KEY,
    streamTitle: 'Public stream title',
    ...overrides,
  };
}

/**
 * Serve `router` on an ephemeral port with an authenticated listener attached, run
 * `exercise` against it, then close. Oxy auth is replaced by a stub because these tests
 * are about what the handler SERIALIZES, not about authentication.
 */
async function withRouter(
  mountPath: string,
  router: express.Router,
  exercise: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthRequest).user = { id: LISTENER_ID };
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

/** Assert a response body carries none of the four internal stream fields. */
function expectNoStreamCredentials(body: string): void {
  expect(body).not.toContain(SECRET_STREAM_KEY);
  expect(body).not.toContain('rtmp://livekit.example/live');
  expect(body).not.toContain('ingress-1');
  expect(body).not.toContain('source.m3u8');
  expect(body).not.toContain('rtmpStreamKey');
  expect(body).not.toContain('rtmpUrl');
  expect(body).not.toContain('activeIngressId');
  expect(body).not.toContain('activeStreamUrl');
}

describe('POST /api/rooms/:id/join', () => {
  it('does not return stream credentials to a listener joining a live room', async () => {
    const room = await Room.create(liveRoomWithCredentials());

    await withRouter('/api/rooms', roomsRoutes, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rooms/${room._id.toString()}/join`, {
        method: 'POST',
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      // The room really is in the payload — otherwise this would pass trivially.
      expect(body).toContain('Joined room successfully');
      expect(body).toContain('Public stream title');
      expectNoStreamCredentials(body);
    });
  });

  it('does not return stream credentials on the already-joined branch', async () => {
    const room = await Room.create(liveRoomWithCredentials({ participants: [LISTENER_ID] }));

    await withRouter('/api/rooms', roomsRoutes, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rooms/${room._id.toString()}/join`, {
        method: 'POST',
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain('Already joined');
      expect(body).toContain('Public stream title');
      expectNoStreamCredentials(body);
    });
  });
});

describe('GET /api/houses/:id/rooms', () => {
  it('does not return stream credentials when listing a house room', async () => {
    const house = await House.create({ name: 'A House', createdBy: HOST_ID });
    await Room.create(liveRoomWithCredentials({ houseId: house._id.toString() }));

    await withRouter('/api/houses', housesRoutes, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/houses/${house._id.toString()}/rooms`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain('Public stream title');
      expectNoStreamCredentials(body);
    });
  });
});
