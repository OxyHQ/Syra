import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import type { NextFunction, Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { RadioPage } from '@syra/shared-types';
import { connect, clear, disconnect } from '../test/mongo';
import { UserMusicPreferencesModel } from '../models/UserMusicPreferences';
import { makeArtist, makeTrack } from '../services/radio/radioFixtures';
import { readRadioStation } from '../services/radio/radioStationStore';
import { PREVIEW_DURATION_SEC } from '../services/ingest/previewClip';
import { getRadioPage, clearRadio, GUEST_PREVIEW_TRACK_LIMIT } from '../controllers/radio.controller';

/**
 * A stand-in for the shared Redis client, mirroring `radioStationStore.test.ts`.
 *
 * Station state is what makes radio pageable — without it every request would be
 * page 0 of a fresh station — so these route tests need a working store, not the
 * Redis-down degradation path.
 */
const fakeRedis = {
  isReady: true,
  entries: new Map<string, string>(),
  get(key: string): Promise<string | null> {
    return Promise.resolve(fakeRedis.entries.get(key) ?? null);
  },
  setEx(key: string, _ttl: number, value: string): Promise<void> {
    fakeRedis.entries.set(key, value);
    return Promise.resolve();
  },
  expire(key: string): Promise<boolean> {
    return Promise.resolve(fakeRedis.entries.has(key));
  },
  del(key: string): Promise<number> {
    return Promise.resolve(fakeRedis.entries.delete(key) ? 1 : 0);
  },
};

// The store resolves the client lazily inside each call, so patching the module
// here — after the static imports above — still takes effect.
mock.module('../utils/redis', () => ({ getRedisClient: () => fakeRedis }));

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

beforeEach(() => {
  fakeRedis.isReady = true;
  fakeRedis.entries.clear();
});

// ── Fake req/res helpers ─────────────────────────────────────────────────────

interface CapturedRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status: (code: number) => CapturedRes;
  set: (name: string, value: string) => CapturedRes;
  json: (body: unknown) => CapturedRes;
  send: (body?: unknown) => CapturedRes;
}

function makeRes(): CapturedRes {
  const res: CapturedRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
  return res;
}

interface CallOptions {
  /** Signed-in listener. Omitted means a guest. */
  userId?: string;
  /** `X-Syra-Device-Id`, for a guest that identifies its device. */
  deviceId?: string;
}

/** Surface a handler error as a test failure instead of an undefined body. */
const next: NextFunction = ((error?: unknown) => {
  if (error) throw error;
}) as NextFunction;

function makeReq(query: Record<string, string>, opts: CallOptions = {}): AuthRequest {
  return {
    query,
    headers: opts.deviceId ? { 'x-syra-device-id': opts.deviceId } : {},
    user: opts.userId ? { id: opts.userId } : undefined,
  } as unknown as AuthRequest;
}

async function callRadio(query: Record<string, string>, opts: CallOptions = {}): Promise<CapturedRes> {
  const res = makeRes();
  await getRadioPage(makeReq(query, opts), res as unknown as Response, next);
  return res;
}

/** The response body as the published wire contract. */
function pageOf(res: CapturedRes): RadioPage {
  return res.body as RadioPage;
}

function trackIdsOf(res: CapturedRes): string[] {
  return pageOf(res).tracks.map((track) => track.id);
}

// ── Catalogue builders ───────────────────────────────────────────────────────

const GENRE = 'deep house';

/** The schema ceiling — the popularity a track must not be able to buy its way in with. */
const MAX_POPULARITY = 100;

/**
 * A catalogue wide enough to page through: the diversity rules cap an artist at
 * two tracks per page, so several artists are needed before a page can fill.
 * Every track sits below {@link MAX_POPULARITY} so a test can plant one above them all.
 */
async function seedCatalogue(artistCount = 6, tracksPerArtist = 3): Promise<void> {
  for (let a = 0; a < artistCount; a += 1) {
    const artistId = await makeArtist({ name: `Artist ${a}` });
    for (let t = 0; t < tracksPerArtist; t += 1) {
      await makeTrack({
        title: `Track ${a}-${t}`,
        artistId,
        artistName: `Artist ${a}`,
        genre: GENRE,
        popularity: MAX_POPULARITY - 10 - a * tracksPerArtist - t,
      });
    }
  }
}

// ── Availability: struck tracks ──────────────────────────────────────────────

describe('GET /api/radio — catalog availability', () => {
  it('never programmes a copyright-removed track, however popular', async () => {
    await seedCatalogue();
    const struck = await makeTrack({
      title: 'Struck',
      artistName: 'Struck Artist',
      genre: GENRE,
      // Top of every pool's popularity sort — it can only be excluded structurally.
      popularity: MAX_POPULARITY,
      copyrightRemoved: true,
    });

    const res = await callRadio({ seedType: 'genre', seedId: GENRE, limit: '20' }, { userId: 'user-1' });

    expect(res.statusCode).toBe(200);
    expect(trackIdsOf(res)).not.toContain(struck._id.toString());
    expect(pageOf(res).tracks.length).toBeGreaterThan(0);
  });

  it('404s a seed that does not exist', async () => {
    await seedCatalogue();

    const res = await callRadio({ seedType: 'genre', seedId: 'no-such-genre' }, { userId: 'user-1' });

    expect(res.statusCode).toBe(404);
  });
});

// ── Listener preference: explicit content ────────────────────────────────────

describe('GET /api/radio — explicit content preference', () => {
  it('never programmes an explicit track for a listener who turned them off', async () => {
    await seedCatalogue();
    const explicit = await makeTrack({
      title: 'Explicit',
      artistName: 'Explicit Artist',
      genre: GENRE,
      popularity: MAX_POPULARITY,
      isExplicit: true,
    });
    await UserMusicPreferencesModel.create({ oxyUserId: 'user-clean', explicitContent: false });

    const res = await callRadio(
      { seedType: 'genre', seedId: GENRE, limit: '20' },
      { userId: 'user-clean' }
    );

    expect(res.statusCode).toBe(200);
    expect(trackIdsOf(res)).not.toContain(explicit._id.toString());
  });

  it('programmes explicit tracks for a listener who left them on', async () => {
    await seedCatalogue();
    const explicit = await makeTrack({
      title: 'Explicit',
      artistName: 'Explicit Artist',
      genre: GENRE,
      popularity: MAX_POPULARITY,
      isExplicit: true,
    });

    const res = await callRadio(
      { seedType: 'genre', seedId: GENRE, limit: '20' },
      { userId: 'user-explicit-ok' }
    );

    expect(trackIdsOf(res)).toContain(explicit._id.toString());
  });
});

// ── The guest wall ───────────────────────────────────────────────────────────

describe('GET /api/radio — guest preview wall', () => {
  it(`caps a guest at ${GUEST_PREVIEW_TRACK_LIMIT} tracks and then closes the station`, async () => {
    await seedCatalogue();

    // The guest asks for a full page; the allowance, not the limit, decides.
    const first = await callRadio(
      { seedType: 'genre', seedId: GENRE, limit: '20' },
      { deviceId: 'device-a' }
    );

    expect(first.statusCode).toBe(200);
    expect(pageOf(first).tracks).toHaveLength(GUEST_PREVIEW_TRACK_LIMIT);
    // Allowance spent on this very page — the station closes with it.
    expect(pageOf(first).cursor).toBeNull();
    expect(pageOf(first).gate).toEqual({
      reason: 'guest-preview-limit',
      previewSeconds: PREVIEW_DURATION_SEC,
    });

    const second = await callRadio(
      { seedType: 'genre', seedId: GENRE, limit: '20' },
      { deviceId: 'device-a' }
    );

    expect(second.statusCode).toBe(200);
    expect(pageOf(second).tracks).toEqual([]);
    expect(pageOf(second).cursor).toBeNull();
    expect(pageOf(second).gate).toEqual({
      reason: 'guest-preview-limit',
      previewSeconds: PREVIEW_DURATION_SEC,
    });
  });

  it('does not gate a signed-in listener', async () => {
    await seedCatalogue();

    const res = await callRadio(
      { seedType: 'genre', seedId: GENRE, limit: '10' },
      { userId: 'user-1' }
    );

    expect(pageOf(res).gate).toBeNull();
    expect(pageOf(res).cursor).not.toBeNull();
    expect(pageOf(res).tracks.length).toBeGreaterThan(GUEST_PREVIEW_TRACK_LIMIT);
  });

  it('keeps each guest device on its own allowance', async () => {
    await seedCatalogue();

    await callRadio({ seedType: 'genre', seedId: GENRE, limit: '20' }, { deviceId: 'device-a' });
    const other = await callRadio(
      { seedType: 'genre', seedId: GENRE, limit: '20' },
      { deviceId: 'device-b' }
    );

    expect(pageOf(other).tracks).toHaveLength(GUEST_PREVIEW_TRACK_LIMIT);
  });
});

// ── Cold start ───────────────────────────────────────────────────────────────

describe('GET /api/radio — personalised station cold start', () => {
  it('serves a non-empty page flagged personalized:false when the listener has no taste yet', async () => {
    await seedCatalogue();

    const res = await callRadio({ seedType: 'user', limit: '10' }, { userId: 'brand-new-user' });

    expect(res.statusCode).toBe(200);
    expect(pageOf(res).station.personalized).toBe(false);
    expect(pageOf(res).station.seedType).toBe('user');
    expect(pageOf(res).station.seedId).toBe('');
    expect(pageOf(res).tracks.length).toBeGreaterThan(0);
  });
});

// ── Paging ───────────────────────────────────────────────────────────────────

describe('GET /api/radio — paging', () => {
  it('never repeats a track across two consecutive pages', async () => {
    await seedCatalogue();

    const first = await callRadio({ seedType: 'genre', seedId: GENRE, limit: '5' }, { userId: 'pager' });
    const cursor = pageOf(first).cursor;
    expect(cursor).not.toBeNull();

    const second = await callRadio({ cursor: cursor ?? '', limit: '5' }, { userId: 'pager' });

    const firstIds = trackIdsOf(first);
    const secondIds = trackIdsOf(second);

    expect(firstIds.length).toBeGreaterThan(0);
    expect(secondIds.length).toBeGreaterThan(0);
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
  });

  it('replays a page a client asks for twice instead of burning fresh catalog', async () => {
    await seedCatalogue();

    const first = await callRadio({ seedType: 'genre', seedId: GENRE, limit: '5' }, { userId: 'retrier' });
    const retry = await callRadio({ seedType: 'genre', seedId: GENRE, limit: '5' }, { userId: 'retrier' });

    expect(trackIdsOf(retry)).toEqual(trackIdsOf(first));
  });

  it('400s a malformed cursor', async () => {
    await seedCatalogue();

    const res = await callRadio({ cursor: 'not-a-real-cursor' }, { userId: 'user-1' });

    expect(res.statusCode).toBe(400);
  });

  it('400s a request with neither cursor nor seedType', async () => {
    const res = await callRadio({}, { userId: 'user-1' });

    expect(res.statusCode).toBe(400);
  });

  it('400s a seedType that needs a seedId but was given none', async () => {
    const res = await callRadio({ seedType: 'artist' }, { userId: 'user-1' });

    expect(res.statusCode).toBe(400);
  });

  it('400s an out-of-range limit', async () => {
    const res = await callRadio({ seedType: 'user', limit: '500' }, { userId: 'user-1' });

    expect(res.statusCode).toBe(400);
  });
});

// ── Owner isolation ──────────────────────────────────────────────────────────

describe('GET /api/radio — owner isolation', () => {
  it('does not let a replayed cursor mutate the station of the listener who minted it', async () => {
    await seedCatalogue();

    const mine = await callRadio({ seedType: 'genre', seedId: GENRE, limit: '5' }, { userId: 'owner-a' });
    const stolenCursor = pageOf(mine).cursor;
    expect(stolenCursor).not.toBeNull();

    const identity = { seedType: 'genre' as const, seedId: GENRE };
    const beforeA = await readRadioStation({ ...identity, ownerKey: 'u:owner-a' });

    // A different listener presents the cursor. It names a station, never an
    // owner — the owner key is always re-derived from the request.
    const theirs = await callRadio({ cursor: stolenCursor ?? '', limit: '5' }, { userId: 'owner-b' });
    expect(theirs.statusCode).toBe(200);

    const afterA = await readRadioStation({ ...identity, ownerKey: 'u:owner-a' });
    const stateB = await readRadioStation({ ...identity, ownerKey: 'u:owner-b' });

    // A's served history is byte-for-byte what A was served.
    expect(afterA.servedTrackIds).toEqual(beforeA.servedTrackIds);
    expect(afterA.servedTrackIds).toEqual(trackIdsOf(mine));
    expect(afterA.page).toBe(beforeA.page);

    // B's history holds only what B was served.
    expect(stateB.servedTrackIds).toEqual(trackIdsOf(theirs));
    expect(stateB.ownerKey).toBe('u:owner-b');
  });
});

// ── Caching ──────────────────────────────────────────────────────────────────

describe('GET /api/radio — caching', () => {
  it('sets Cache-Control: no-store on a served page', async () => {
    await seedCatalogue();

    const res = await callRadio({ seedType: 'genre', seedId: GENRE }, { userId: 'user-1' });

    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('sets Cache-Control: no-store on a rejected request too', async () => {
    const res = await callRadio({ cursor: 'garbage' }, { userId: 'user-1' });

    expect(res.statusCode).toBe(400);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});

// ── DELETE ───────────────────────────────────────────────────────────────────

describe('DELETE /api/radio', () => {
  it('clears the station so the next request starts over', async () => {
    await seedCatalogue();

    const first = await callRadio({ seedType: 'genre', seedId: GENRE, limit: '5' }, { userId: 'resetter' });
    expect(pageOf(first).tracks.length).toBeGreaterThan(0);

    const deleteRes = makeRes();
    await clearRadio(
      makeReq({ seedType: 'genre', seedId: GENRE }, { userId: 'resetter' }),
      deleteRes as unknown as Response,
      next
    );
    expect(deleteRes.statusCode).toBe(204);

    const state = await readRadioStation({
      seedType: 'genre',
      seedId: GENRE,
      ownerKey: 'u:resetter',
    });
    expect(state.servedTrackIds).toEqual([]);
    expect(state.page).toBe(0);
  });

  it('resets a guest allowance', async () => {
    await seedCatalogue();

    await callRadio({ seedType: 'genre', seedId: GENRE, limit: '20' }, { deviceId: 'device-c' });

    const deleteRes = makeRes();
    await clearRadio(
      makeReq({ seedType: 'genre', seedId: GENRE }, { deviceId: 'device-c' }),
      deleteRes as unknown as Response,
      next
    );

    const again = await callRadio(
      { seedType: 'genre', seedId: GENRE, limit: '20' },
      { deviceId: 'device-c' }
    );
    expect(pageOf(again).tracks).toHaveLength(GUEST_PREVIEW_TRACK_LIMIT);
  });

  it('400s a clear with no seedType', async () => {
    const res = makeRes();
    await clearRadio(makeReq({}, { userId: 'user-1' }), res as unknown as Response, next);

    expect(res.statusCode).toBe(400);
  });
});
