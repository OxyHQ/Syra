import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { connect, clear, disconnect } from '../test/mongo';
import RoomUserPreference, { LiveVisibility, DEFAULT_LIVE_VISIBILITY } from '../models/RoomUserPreference';
import { selectLiveUsers } from './rooms.routes';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

// ── selectLiveUsers — pure filtering ──────────────────────────────────────────

describe('selectLiveUsers', () => {
  it('includes host + speakers for the default (active) preference and never listeners', () => {
    const rooms = [
      { _id: 'r1', host: 'host1', speakers: ['host1', 'speaker1'] },
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
      { _id: 'r2', host: 'host2', speakers: ['speakerX'] },
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
      { _id: 'r3', host: 'host3', speakers: ['host3'] },
    ];
    const prefs = new Map<string, LiveVisibility>([['host3', 'speaking']]);

    expect(selectLiveUsers(rooms, prefs)).toEqual([{ userId: 'host3', roomId: 'r3' }]);
  });

  it('yields one entry per (userId, roomId) across multiple live rooms', () => {
    const rooms = [
      { _id: 'r1', host: 'dj', speakers: ['dj'] },
      { _id: 'r2', host: 'dj', speakers: ['dj'] },
    ];

    expect(selectLiveUsers(rooms, new Map())).toEqual([
      { userId: 'dj', roomId: 'r1' },
      { userId: 'dj', roomId: 'r2' },
    ]);
  });
});

// ── RoomUserPreference — upsert ────────────────────────────────────────────────

describe('RoomUserPreference upsert', () => {
  it("defaults liveVisibility to 'active' when unset", async () => {
    const created = await RoomUserPreference.create({ userId: 'user-default' });
    expect(created.liveVisibility).toBe(DEFAULT_LIVE_VISIBILITY);
    expect(DEFAULT_LIVE_VISIBILITY).toBe('active');
  });

  it('upserts a single row keyed by userId (insert then update in place)', async () => {
    const inserted = await RoomUserPreference.findOneAndUpdate(
      { userId: 'user-1' },
      { $set: { liveVisibility: 'speaking' } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    expect(inserted?.liveVisibility).toBe('speaking');

    const updated = await RoomUserPreference.findOneAndUpdate(
      { userId: 'user-1' },
      { $set: { liveVisibility: 'active' } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    expect(updated?.liveVisibility).toBe('active');

    // Still exactly one row for this user — the upsert updated in place.
    expect(await RoomUserPreference.countDocuments({ userId: 'user-1' })).toBe(1);
  });
});
