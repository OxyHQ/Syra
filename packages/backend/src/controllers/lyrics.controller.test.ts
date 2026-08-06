import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, lyrics, lyricsLines, tracks } from '../db/schema/catalog';
import { getLyrics } from './lyrics.controller';
import type { Request, Response } from 'express';

/**
 * Postgres only. `lyricsService` moved to drizzle in Task 10b while this suite
 * still seeded Mongo, which is why it was red: the handler reached `getDb()`
 * before anything had connected. Nothing in this path touches Mongoose now.
 */
beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/** `lyrics.track_id` is a real foreign key, so a track has to exist first. */
async function seedTrack(): Promise<string> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: `Artist ${suffix}`,
      nameKey: `artist-${suffix}`,
      source: 'upload',
    })
    .returning({ id: catalogEntities.id });
  if (!artist) throw new Error('seedTrack: artist insert returned no row');

  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: 'A Track',
      artistId: artist.id,
      artistName: 'Artist',
      duration: 180,
      source: 'upload',
      status: 'ready',
    })
    .returning({ id: tracks.id });
  if (!track) throw new Error('seedTrack: track insert returned no row');

  return track.id;
}

// ── Fake req/res helpers ──────────────────────────────────────────────────────

interface CapturedRes {
  _status: number;
  _body: unknown;
  _headers: Record<string, string>;
  status(code: number): CapturedRes;
  set(name: string, value: string): CapturedRes;
  json(body: unknown): CapturedRes;
}

function makeRes(): CapturedRes {
  const res: CapturedRes = {
    _status: 200,
    _body: undefined,
    _headers: {},
    status(code) { this._status = code; return this; },
    set(name, value) { this._headers[name] = value; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

function makeReq(trackId: string): Request {
  return { params: { trackId } } as unknown as Request;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/lyrics/:trackId', () => {
  it('returns 400 for an id in neither live shape', async () => {
    const req = makeReq('not-an-id-in-either-shape');
    const res = makeRes();

    await getLyrics(req, res as unknown as Response);

    expect(res._status).toBe(400);
    expect((res._body as Record<string, string>).error).toContain('Invalid');
  });

  it('returns 200 with lyrics when a cached row exists', async () => {
    const trackId = await seedTrack();
    const [cached] = await getDb()
      .insert(lyrics)
      .values({ trackId, synced: true, source: 'lrclib' })
      .returning({ id: lyrics.id });
    if (!cached) throw new Error('lyrics insert returned no row');
    await getDb()
      .insert(lyricsLines)
      .values({ lyricsId: cached.id, position: 0, timeMs: 1000, text: 'hello' });

    const req = makeReq(trackId);
    const res = makeRes();

    await getLyrics(req, res as unknown as Response);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body.trackId).toBe(trackId);
    expect(body.synced).toBe(true);
    expect((body.lines as unknown[]).length).toBe(1);
  });

  it('returns 404 when no lyrics and no track exist', async () => {
    const trackId = uuidv7();
    const req = makeReq(trackId);
    const res = makeRes();

    await getLyrics(req, res as unknown as Response);

    expect(res._status).toBe(404);
    expect((res._body as Record<string, string>).error).toContain('not found');
  });
});
