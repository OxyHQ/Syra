import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  readRadioStation,
  writeRadioStation,
  clearRadioStation,
  createRadioStationState,
  recordServedPage,
  findServedPage,
  MAX_SERVED_TRACK_IDS,
  RECENT_PAGE_MEMORY,
  FRONTIER_SIZE,
  RADIO_STATION_TTL_SECONDS,
} from './radioStationStore';

/**
 * A stand-in for the shared Redis client. `isReady` is mutable so the
 * Redis-unavailable branch — a designed degradation, not an error path — can be
 * exercised without depending on whether a Redis happens to be running.
 */
const fakeRedis = {
  isReady: true,
  entries: new Map<string, string>(),
  ttls: new Map<string, number>(),
  get(key: string): Promise<string | null> {
    return Promise.resolve(fakeRedis.entries.get(key) ?? null);
  },
  setEx(key: string, ttl: number, value: string): Promise<void> {
    fakeRedis.entries.set(key, value);
    fakeRedis.ttls.set(key, ttl);
    return Promise.resolve();
  },
  expire(key: string, ttl: number): Promise<boolean> {
    if (!fakeRedis.entries.has(key)) {
      return Promise.resolve(false);
    }
    fakeRedis.ttls.set(key, ttl);
    return Promise.resolve(true);
  },
  del(key: string): Promise<number> {
    const existed = fakeRedis.entries.delete(key);
    fakeRedis.ttls.delete(key);
    return Promise.resolve(existed ? 1 : 0);
  },
};

// The store resolves the client lazily inside each call, so patching the module
// here — after the static import above — still takes effect.
mock.module('../../utils/redis', () => ({ getRedisClient: () => fakeRedis }));

const IDENTITY = { seedType: 'track' as const, seedId: 'track-1', ownerKey: 'user:abc' };
const STATION_KEY = 'radio:station:user:abc:track:track-1';

beforeEach(() => {
  fakeRedis.isReady = true;
  fakeRedis.entries.clear();
  fakeRedis.ttls.clear();
});

describe('recordServedPage — servedTrackIds FIFO cap', () => {
  it(`keeps the newest ${MAX_SERVED_TRACK_IDS} ids and evicts the oldest`, () => {
    let state = createRadioStationState(IDENTITY);

    // 60 pages of 20 tracks = 1200 ids, 200 over the cap.
    for (let page = 0; page < 60; page += 1) {
      const trackIds = Array.from({ length: 20 }, (_, i) => `id-${page * 20 + i}`);
      state = recordServedPage(state, page, trackIds, { guest: false, wrapped: false });
    }

    expect(state.servedTrackIds).toHaveLength(MAX_SERVED_TRACK_IDS);
    expect(state.servedTrackIds[0]).toBe('id-200');
    expect(state.servedTrackIds.at(-1)).toBe('id-1199');
    expect(state.servedTrackIds).not.toContain('id-199');
  });

  it('does not evict while under the cap', () => {
    let state = createRadioStationState(IDENTITY);
    state = recordServedPage(state, 0, ['a', 'b', 'c'], { guest: false, wrapped: false });
    expect(state.servedTrackIds).toEqual(['a', 'b', 'c']);
  });

  it(`tracks the last ${FRONTIER_SIZE} served ids as the frontier`, () => {
    let state = createRadioStationState(IDENTITY);
    const trackIds = Array.from({ length: 20 }, (_, i) => `t-${i}`);
    state = recordServedPage(state, 0, trackIds, { guest: false, wrapped: false });

    expect(state.frontierTrackIds).toHaveLength(FRONTIER_SIZE);
    expect(state.frontierTrackIds).toEqual(trackIds.slice(-FRONTIER_SIZE));
  });

  it('does not mutate the state it was given', () => {
    const state = createRadioStationState(IDENTITY);
    recordServedPage(state, 0, ['a', 'b'], { guest: false, wrapped: false });
    expect(state.servedTrackIds).toEqual([]);
    expect(state.page).toBe(0);
  });
});

describe(`recordServedPage — recentPages keeps ${RECENT_PAGE_MEMORY}`, () => {
  it('remembers only the most recent pages', () => {
    let state = createRadioStationState(IDENTITY);
    for (let page = 0; page < 5; page += 1) {
      state = recordServedPage(state, page, [`p${page}-a`, `p${page}-b`], {
        guest: false,
        wrapped: false,
      });
    }

    expect(state.recentPages).toHaveLength(RECENT_PAGE_MEMORY);
    expect(state.recentPages.map((entry) => entry.page)).toEqual([2, 3, 4]);
    expect(findServedPage(state, 4)?.trackIds).toEqual(['p4-a', 'p4-b']);
    expect(findServedPage(state, 0)).toBeNull();
  });

  it('replaces rather than duplicates when the same page is served again', () => {
    let state = createRadioStationState(IDENTITY);
    state = recordServedPage(state, 0, ['a'], { guest: false, wrapped: false });
    state = recordServedPage(state, 0, ['b'], { guest: false, wrapped: false });

    expect(state.recentPages.filter((entry) => entry.page === 0)).toHaveLength(1);
    expect(findServedPage(state, 0)?.trackIds).toEqual(['b']);
  });

  it('advances the page counter and counts guest-served tracks', () => {
    let state = createRadioStationState(IDENTITY);
    state = recordServedPage(state, 0, ['a', 'b'], { guest: true, wrapped: false });
    expect(state.page).toBe(1);
    expect(state.guestServedCount).toBe(2);

    state = recordServedPage(state, 1, ['c'], { guest: false, wrapped: false });
    expect(state.page).toBe(2);
    expect(state.guestServedCount).toBe(2);
  });

  it('stamps wrappedAt once, on the first wrap', () => {
    let state = createRadioStationState(IDENTITY);
    expect(state.wrappedAt).toBeUndefined();

    state = recordServedPage(state, 0, ['a'], { guest: false, wrapped: true });
    const firstWrap = state.wrappedAt;
    expect(typeof firstWrap).toBe('number');

    state = recordServedPage(state, 1, ['b'], { guest: false, wrapped: true });
    expect(state.wrappedAt).toBe(firstWrap);
  });
});

describe('readRadioStation / writeRadioStation / clearRadioStation', () => {
  it('round-trips a station through Redis under the documented key', async () => {
    let state = createRadioStationState(IDENTITY);
    state = recordServedPage(state, 0, ['a', 'b'], { guest: false, wrapped: false });

    expect(await writeRadioStation(state)).toBe(true);
    expect(fakeRedis.entries.has(STATION_KEY)).toBe(true);
    expect(fakeRedis.ttls.get(STATION_KEY)).toBe(RADIO_STATION_TTL_SECONDS);

    expect(await readRadioStation(IDENTITY)).toEqual(state);
  });

  it('returns a fresh station when none is stored', async () => {
    const state = await readRadioStation(IDENTITY);
    expect(state.page).toBe(0);
    expect(state.servedTrackIds).toEqual([]);
    expect(state.ownerKey).toBe(IDENTITY.ownerKey);
  });

  it('refreshes the TTL on read', async () => {
    await writeRadioStation(createRadioStationState(IDENTITY));
    fakeRedis.ttls.set(STATION_KEY, 5);

    await readRadioStation(IDENTITY);
    expect(fakeRedis.ttls.get(STATION_KEY)).toBe(RADIO_STATION_TTL_SECONDS);
  });

  it('falls back to a fresh station when the stored entry is corrupt', async () => {
    fakeRedis.entries.set(STATION_KEY, 'not json at all');
    const state = await readRadioStation(IDENTITY);
    expect(state.servedTrackIds).toEqual([]);
    expect(state.page).toBe(0);
  });

  it('falls back to a fresh station when the stored entry has a stale version', async () => {
    fakeRedis.entries.set(STATION_KEY, JSON.stringify({ v: 99, page: 7 }));
    expect((await readRadioStation(IDENTITY)).page).toBe(0);
  });

  it('refuses an entry whose ownerKey does not match the caller', async () => {
    const foreign = { ...createRadioStationState(IDENTITY), ownerKey: 'user:someone-else', page: 9 };
    fakeRedis.entries.set(STATION_KEY, JSON.stringify(foreign));

    const state = await readRadioStation(IDENTITY);
    expect(state.ownerKey).toBe(IDENTITY.ownerKey);
    expect(state.page).toBe(0);
  });

  it('clears a station', async () => {
    await writeRadioStation(createRadioStationState(IDENTITY));
    expect(await clearRadioStation(IDENTITY)).toBe(true);
    expect(fakeRedis.entries.has(STATION_KEY)).toBe(false);
  });
});

describe('Redis unavailable — degrades instead of failing', () => {
  beforeEach(() => {
    fakeRedis.isReady = false;
  });

  it('readRadioStation returns a usable stateless station instead of throwing', async () => {
    const state = await readRadioStation(IDENTITY);

    expect(state.v).toBe(1);
    expect(state.ownerKey).toBe(IDENTITY.ownerKey);
    expect(state.seedType).toBe(IDENTITY.seedType);
    expect(state.seedId).toBe(IDENTITY.seedId);
    expect(state.page).toBe(0);
    expect(state.servedTrackIds).toEqual([]);
    expect(state.frontierTrackIds).toEqual([]);
    expect(state.recentPages).toEqual([]);
    expect(state.guestServedCount).toBe(0);
  });

  it('the stateless station still accepts served pages, so tracks keep flowing', async () => {
    const state = await readRadioStation(IDENTITY);
    const next = recordServedPage(state, 0, ['a', 'b'], { guest: false, wrapped: false });

    expect(next.servedTrackIds).toEqual(['a', 'b']);
    expect(next.page).toBe(1);
  });

  it('writeRadioStation reports failure without throwing', async () => {
    expect(await writeRadioStation(createRadioStationState(IDENTITY))).toBe(false);
  });

  it('clearRadioStation reports failure without throwing', async () => {
    expect(await clearRadioStation(IDENTITY)).toBe(false);
  });

  it('a read after a dropped write still serves a fresh station', async () => {
    await writeRadioStation(createRadioStationState(IDENTITY));
    const state = await readRadioStation(IDENTITY);
    expect(state.page).toBe(0);
  });
});

describe('Redis throwing — degrades instead of failing', () => {
  it('readRadioStation swallows a client error and serves a fresh station', async () => {
    const original = fakeRedis.get;
    fakeRedis.get = () => Promise.reject(new Error('connection reset'));

    const state = await readRadioStation(IDENTITY);
    expect(state.page).toBe(0);
    expect(state.ownerKey).toBe(IDENTITY.ownerKey);

    fakeRedis.get = original;
  });

  it('writeRadioStation swallows a client error and reports false', async () => {
    const original = fakeRedis.setEx;
    fakeRedis.setEx = () => Promise.reject(new Error('connection reset'));

    expect(await writeRadioStation(createRadioStationState(IDENTITY))).toBe(false);

    fakeRedis.setEx = original;
  });
});
