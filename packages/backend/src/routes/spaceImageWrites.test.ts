import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { createHouse, findHouseWithMembers, updateHouse } from '../db/rooms/houses';
import { createSeries, findSeriesById, updateSeries } from '../db/rooms/series';
import {
  DEFAULT_HOUSE_VISIBILITY,
  RecurrenceType,
  RoomType,
  SpeakerPermission,
} from '../db/rooms/types';
import housesRoutes from './houses.routes';
import seriesRoutes from './series.routes';

/**
 * A house or series image is an Oxy file, stored only by its upload route
 * (`services/oxyFiles/spaceImages.ts`). The create and PATCH routes once took a
 * URL for it, stored in a column of its own; that column is gone, so a URL
 * there is refused rather than silently dropped, and `null` removes the file.
 */

const OWNER = 'owner-1';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

async function send(
  router: express.Router,
  method: string,
  path: string,
  json: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthRequest).user = { id: OWNER };
    next();
  });
  app.use('/', router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(json),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function house() {
  const { house: created } = await createHouse({
    name: 'H',
    createdBy: OWNER,
    visibility: DEFAULT_HOUSE_VISIBILITY,
    tags: [],
  });
  await updateHouse(created.id, { avatarFileId: 'file-avatar', coverImageFileId: 'file-cover' });
  return created.id;
}

async function series() {
  const row = await createSeries({
    title: 'S',
    createdBy: OWNER,
    recurrence: { type: RecurrenceType.WEEKLY, time: '18:00', timezone: 'UTC' },
    roomTemplate: {
      titlePattern: 'Episode {n}',
      type: RoomType.TALK,
      maxParticipants: 10,
      speakerPermission: SpeakerPermission.INVITED,
      tags: [],
    },
  });
  await updateSeries(row.id, { coverImageFileId: 'file-series' });
  return row.id;
}

describe('house images', () => {
  it('refuses a URL image on create', async () => {
    const res = await send(housesRoutes, 'POST', '/', {
      name: 'H',
      avatar: 'https://elsewhere.example/a.png',
    });
    expect(res.status).toBe(400);
  });

  it('refuses a URL image on PATCH and leaves the files alone', async () => {
    const id = await house();
    const res = await send(housesRoutes, 'PATCH', `/${id}`, {
      coverImage: 'https://elsewhere.example/c.png',
    });
    expect(res.status).toBe(400);
    const found = await findHouseWithMembers(id);
    expect(found?.house).toMatchObject({
      avatarFileId: 'file-avatar',
      coverImageFileId: 'file-cover',
    });
  });

  it('removes an image with null, and only that one', async () => {
    const id = await house();
    const res = await send(housesRoutes, 'PATCH', `/${id}`, { avatar: null });
    expect(res.status).toBe(200);
    const found = await findHouseWithMembers(id);
    expect(found?.house).toMatchObject({ avatarFileId: null, coverImageFileId: 'file-cover' });
  });
});

describe('series covers', () => {
  it('refuses a URL cover on create', async () => {
    const res = await send(seriesRoutes, 'POST', '/', {
      title: 'S',
      coverImage: 'https://elsewhere.example/s.png',
      recurrence: { type: RecurrenceType.WEEKLY, time: '18:00', timezone: 'UTC' },
      roomTemplate: { titlePattern: 'Episode {n}' },
    });
    expect(res.status).toBe(400);
  });

  it('refuses a URL cover on PATCH, and removes the cover with null', async () => {
    const id = await series();
    const refused = await send(seriesRoutes, 'PATCH', `/${id}`, {
      coverImage: 'https://elsewhere.example/s.png',
    });
    expect(refused.status).toBe(400);
    expect((await findSeriesById(id))?.coverImageFileId).toBe('file-series');

    const removed = await send(seriesRoutes, 'PATCH', `/${id}`, { coverImage: null });
    expect(removed.status).toBe(200);
    expect((await findSeriesById(id))?.coverImageFileId).toBeNull();
  });
});
