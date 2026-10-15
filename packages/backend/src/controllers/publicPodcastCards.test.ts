import { beforeAll, afterAll, afterEach, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { eq } from 'drizzle-orm';
import { connectDb, clearDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { podcasts } from '../db/schema/podcasts';
import { apiCors } from '../middleware/apiCors';
import { createPublicPodcastCardsRouter } from '../routes/publicPodcastCards.routes';
import { createSyraClient } from '@syra.fm/sdk/client';
let server: Server;
let baseURL: string;
beforeAll(async () => {
  await connectDb();
  const app = express();
  app.use(apiCors);
  app.use('/api/podcasts/public-cards', createPublicPodcastCardsRouter(undefined, 20));
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  baseURL = `http://127.0.0.1:${address.port}`;
});
afterEach(clearDb);
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectDb();
});
const post = (body: unknown) =>
  fetch(`${baseURL}/api/podcasts/public-cards`, {
    method: 'POST',
    headers: { Origin: 'https://mention.earth', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
describe('public podcast cards over real HTTP and PostgreSQL', () => {
  it('serves one batch through SDK and drops private, unlisted, unpublished and deleted shows', async () => {
    await getDb()
      .insert(podcasts)
      .values([
        { source: 'syra', id: 'public', title: 'Visible', status: 'active', visibility: 'public' },
        {
          source: 'syra',
          id: 'private',
          title: 'Secret',
          status: 'active',
          visibility: 'private',
          ownerOxyUserId: 'owner',
        },
        {
          source: 'syra',
          id: 'unlisted',
          title: 'Hidden',
          status: 'active',
          visibility: 'unlisted',
        },
        {
          source: 'syra',
          id: 'inactive',
          title: 'Withdrawn',
          status: 'removed',
          visibility: 'public',
        },
      ]);
    const api = createSyraClient({ baseURL });
    const batch = await api.getPublicPodcastCards([
      'public',
      'private',
      'unlisted',
      'inactive',
      'deleted',
      'public',
    ]);
    expect(batch.items).toEqual([
      { id: 'public', title: 'Visible', showUrl: 'https://syra.fm/podcasts/public' },
    ]);
    expect(batch.unavailableIds).toEqual(['private', 'unlisted', 'inactive', 'deleted']);
    await getDb().update(podcasts).set({ visibility: 'private' }).where(eq(podcasts.id, 'public'));
    expect(await api.getPublicPodcastCards(['public'])).toEqual({
      items: [],
      unavailableIds: ['public'],
    });
  });
  it('allows Mention browser preflight and POST with no-store, validates shape and bound', async () => {
    const preflight = await fetch(`${baseURL}/api/podcasts/public-cards`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://mention.earth',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://mention.earth');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    const response = await post({ ids: ['missing'] });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://mention.earth');
    expect(response.headers.get('cache-control')).toBe('no-store');
    for (const body of [
      { ids: [] },
      { ids: ['x'], extra: true },
      { ids: Array(101).fill('x') },
      { ids: [7] },
    ]) {
      const invalid = await post(body);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: 'bad_request' } });
    }
  });
  it('returns contract errors for malformed JSON and rate limiting', async () => {
    const malformed = await fetch(`${baseURL}/api/podcasts/public-cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'bad_request' } });
    let limited: Response | undefined;
    for (let i = 0; i < 25; i++) {
      const response = await post({ ids: ['missing'] });
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited?.json()).toMatchObject({
      error: { code: 'rate_limited', details: { retryAfterSeconds: expect.any(Number) } },
    });
  });
});
