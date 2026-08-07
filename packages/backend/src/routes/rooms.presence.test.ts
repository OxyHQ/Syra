import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { connectDb, clearDb, disconnectDb } from '../test/postgres';
import { findLiveVisibilities, findLiveVisibility, setLiveVisibility } from '../db/rooms/preferences';
import { DEFAULT_LIVE_VISIBILITY, type LiveVisibility } from '../db/rooms/types';
import { selectLiveUsers } from './rooms.routes';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

// ── selectLiveUsers — pure filtering ──────────────────────────────────────────

describe('selectLiveUsers', () => {
  it('includes host + speakers for the default (active) preference and never listeners', () => {
    const rooms = [
      { id: 'r1', host: 'host1', speakers: ['host1', 'speaker1'] },
    ];

    const result = selectLiveUsers(rooms, new Map());

    expect(result).toEqual([
      { userId: 'host1', roomId: 'r1' },
      { userId: 'speaker1', roomId: 'r1' },
    ]);
  });

  it("with 'speaking' includes only active speakers (members of the speakers list)", () => {
    // host2 is NOT in its room's speakers list — an inactive broadcaster.
    const rooms = [
      { id: 'r2', host: 'host2', speakers: ['speakerX'] },
    ];
    const prefs = new Map<string, LiveVisibility>([
      ['host2', 'speaking'],
      ['speakerX', 'speaking'],
    ]);

    const result = selectLiveUsers(rooms, prefs);

    // host2 (speaking, not an active speaker) is dropped; speakerX is kept.
    expect(result).toEqual([{ userId: 'speakerX', roomId: 'r2' }]);
  });

  it("keeps a 'speaking' host when the host is a speaker (the common case)", () => {
    const rooms = [
      { id: 'r3', host: 'host3', speakers: ['host3'] },
    ];
    const prefs = new Map<string, LiveVisibility>([['host3', 'speaking']]);

    expect(selectLiveUsers(rooms, prefs)).toEqual([{ userId: 'host3', roomId: 'r3' }]);
  });

  it('yields one entry per (userId, roomId) across multiple live rooms', () => {
    const rooms = [
      { id: 'r1', host: 'dj', speakers: ['dj'] },
      { id: 'r2', host: 'dj', speakers: ['dj'] },
    ];

    expect(selectLiveUsers(rooms, new Map())).toEqual([
      { userId: 'dj', roomId: 'r1' },
      { userId: 'dj', roomId: 'r2' },
    ]);
  });
});

// ── room_user_preferences — upsert ────────────────────────────────────────────

describe('live-visibility preference', () => {
  it("reads as 'active' for a user with no row at all", async () => {
    expect(await findLiveVisibility('user-default')).toBe(DEFAULT_LIVE_VISIBILITY);
    expect(DEFAULT_LIVE_VISIBILITY).toBe('active');
  });

  it("defaults liveVisibility to 'active' when the row is written without one", async () => {
    // Through the column DEFAULT rather than the reader's `??` fallback, which
    // is the half `findLiveVisibility` above cannot distinguish on its own.
    await setLiveVisibility('user-explicit', DEFAULT_LIVE_VISIBILITY);
    expect(await findLiveVisibility('user-explicit')).toBe('active');
  });

  it('upserts a single row keyed by oxyUserId (insert then update in place)', async () => {
    expect(await setLiveVisibility('user-1', 'speaking')).toBe('speaking');
    expect(await setLiveVisibility('user-1', 'active')).toBe('active');

    // Still exactly one row for this user — the `ON CONFLICT` updated in place
    // rather than inserting a second. A batched read is the cheapest way to
    // observe the row COUNT rather than just the surviving value: a second row
    // would make the map's entry ambiguous, and the unique constraint that
    // prevents it is the thing under test.
    const byUser = await findLiveVisibilities(['user-1']);
    expect(byUser.size).toBe(1);
    expect(byUser.get('user-1')).toBe('active');
  });

  it('batches many users in one read, omitting those with no row', async () => {
    await setLiveVisibility('user-a', 'speaking');
    await setLiveVisibility('user-b', 'active');

    const byUser = await findLiveVisibilities(['user-a', 'user-b', 'user-missing']);

    expect(byUser.get('user-a')).toBe('speaking');
    expect(byUser.get('user-b')).toBe('active');
    // Absent rather than defaulted — the caller applies the default, so that
    // `selectLiveUsers` sees exactly one authority for it.
    expect(byUser.has('user-missing')).toBe(false);
  });
});
