import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { playbackStates } from '../../db/schema/library';
import { catalogEntities, tracks } from '../../db/schema/catalog';
import {
  getOrCreateState,
  setNowPlaying,
  applyCommand,
  updateProgress,
  handleDeviceDisconnect,
  toConnectPlaybackState,
} from './playbackStateService';
import { registerDevice } from './deviceService';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const USER = 'user-state-test';

/**
 * Every track id this suite names, as real rows.
 *
 * `playback_states.track_id` is a real `.references(() => tracks.id)` — Mongo
 * had no such constraint, so these fixtures used to be bare strings naming
 * nothing. The ids are inserted verbatim rather than generated, because the
 * queue-navigation assertions are written against their ORDER ("next from b
 * goes to c"), which a generated id would make unreadable.
 */
const TRACK_IDS = [
  'track-abc',
  'track-def',
  'track-ghi',
  'track-t',
  'track-1',
  'track-2',
  'track-a',
  'track-b',
  'track-c',
] as const;

beforeEach(async () => {
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({ name: 'Playback Fixture Artist', type: 'artist', source: 'upload' })
    .returning({ id: catalogEntities.id });

  await getDb().insert(tracks).values(
    TRACK_IDS.map((id) => ({
      id,
      title: `Fixture ${id}`,
      artistId: artist.id,
      artistName: 'Playback Fixture Artist',
      duration: 180,
      source: 'upload' as const,
    }))
  );
});

/** The stored row, re-read — distinct from what a writer handed back. */
async function storedState(oxyUserId: string) {
  const [row] = await getDb()
    .select()
    .from(playbackStates)
    .where(eq(playbackStates.oxyUserId, oxyUserId));
  return row;
}

describe('getOrCreateState', () => {
  it('creates a state row with defaults', async () => {
    const state = await getOrCreateState(USER);

    expect(state.oxyUserId).toBe(USER);
    expect(state.positionMs).toBe(0);
    expect(state.isPlaying).toBe(false);
    expect(state.volume).toBe(1);
    expect(state.repeat).toBe('off');
    expect(state.shuffle).toBe(false);
    expect(state.queue).toEqual([]);
  });

  it('is idempotent — second call returns the same row, count stays 1', async () => {
    const first = await getOrCreateState(USER);
    const second = await getOrCreateState(USER);

    expect(second.id).toBe(first.id);
    const rows = await getDb()
      .select()
      .from(playbackStates)
      .where(eq(playbackStates.oxyUserId, USER));
    expect(rows).toHaveLength(1);
  });
});

describe('setNowPlaying', () => {
  it('sets trackId, queue, positionMs=0, isPlaying=true, activeDeviceId', async () => {
    const state = await setNowPlaying(USER, {
      trackId: 'track-abc',
      source: 'upload',
      queue: ['track-abc', 'track-def', 'track-ghi'],
      contextType: 'album',
      contextId: 'album-1',
      deviceId: 'device-web',
    });

    expect(state.trackId).toBe('track-abc');
    expect(state.source).toBe('upload');
    expect(state.queue).toEqual(['track-abc', 'track-def', 'track-ghi']);
    expect(state.contextType).toBe('album');
    expect(state.contextId).toBe('album-1');
    expect(state.positionMs).toBe(0);
    expect(state.isPlaying).toBe(true);
    expect(state.activeDeviceId).toBe('device-web');
  });

  it('preserves existing activeDeviceId when deviceId not provided', async () => {
    await setNowPlaying(USER, { trackId: 'track-1', deviceId: 'device-web' });
    const state = await setNowPlaying(USER, { trackId: 'track-2' });
    expect(state.activeDeviceId).toBe('device-web');
  });
});

describe('applyCommand — playback controls', () => {
  it('play → isPlaying true', async () => {
    await getOrCreateState(USER);
    const state = await applyCommand(USER, { type: 'play' });
    expect(state.isPlaying).toBe(true);
  });

  it('pause → isPlaying false', async () => {
    await setNowPlaying(USER, { trackId: 'track-abc' });
    const state = await applyCommand(USER, { type: 'pause' });
    expect(state.isPlaying).toBe(false);
  });

  it('seek → positionMs updated', async () => {
    await getOrCreateState(USER);
    const state = await applyCommand(USER, { type: 'seek', positionMs: 30000 });
    expect(state.positionMs).toBe(30000);
  });

  it('seek clamps to ≥0', async () => {
    await getOrCreateState(USER);
    const state = await applyCommand(USER, { type: 'seek', positionMs: -500 });
    expect(state.positionMs).toBe(0);
  });

  it('volume 0.5 → volume 0.5', async () => {
    await getOrCreateState(USER);
    const state = await applyCommand(USER, { type: 'volume', volume: 0.5 });
    expect(state.volume).toBe(0.5);
  });

  it('volume clamps 1.5 → 1', async () => {
    await getOrCreateState(USER);
    const state = await applyCommand(USER, { type: 'volume', volume: 1.5 });
    expect(state.volume).toBe(1);
  });

  it('volume clamps -1 → 0', async () => {
    await getOrCreateState(USER);
    const state = await applyCommand(USER, { type: 'volume', volume: -1 });
    expect(state.volume).toBe(0);
  });

  it('shuffle with no value toggles (false → true)', async () => {
    await getOrCreateState(USER);
    const state = await applyCommand(USER, { type: 'shuffle' });
    expect(state.shuffle).toBe(true);
  });

  it('shuffle false → false when explicit value given', async () => {
    await setNowPlaying(USER, { trackId: 'track-abc' });
    await applyCommand(USER, { type: 'shuffle' }); // toggle to true
    const state = await applyCommand(USER, { type: 'shuffle', shuffle: false });
    expect(state.shuffle).toBe(false);
  });

  it('repeat "all" → repeat "all"', async () => {
    await getOrCreateState(USER);
    const state = await applyCommand(USER, { type: 'repeat', repeat: 'all' });
    expect(state.repeat).toBe('all');
  });

  it('transfer sets activeDeviceId, keeps trackId + positionMs', async () => {
    await setNowPlaying(USER, { trackId: 'track-abc', deviceId: 'device-web' });
    await applyCommand(USER, { type: 'seek', positionMs: 45000 });

    const state = await applyCommand(USER, { type: 'transfer', deviceId: 'device-mobile' });

    expect(state.activeDeviceId).toBe('device-mobile');
    expect(state.trackId).toBe('track-abc');
    expect(state.positionMs).toBe(45000);
  });

  it('transfer without deviceId leaves activeDeviceId unchanged', async () => {
    await setNowPlaying(USER, { trackId: 'track-abc', deviceId: 'device-web' });
    const state = await applyCommand(USER, { type: 'transfer' });
    expect(state.activeDeviceId).toBe('device-web');
  });
});

describe('applyCommand — next/prev queue navigation', () => {
  const QUEUE = ['track-a', 'track-b', 'track-c'];

  async function seedQueue(trackId: string, repeat: 'off' | 'all' | 'one' = 'off') {
    await setNowPlaying(USER, { trackId, queue: QUEUE });
    if (repeat !== 'off') {
      await applyCommand(USER, { type: 'repeat', repeat });
    }
  }

  it('next from "b" → "c", positionMs reset to 0', async () => {
    await seedQueue('track-b');
    const state = await applyCommand(USER, { type: 'next' });
    expect(state.trackId).toBe('track-c');
    expect(state.positionMs).toBe(0);
  });

  it('prev from "b" → "a", positionMs reset to 0', async () => {
    await seedQueue('track-b');
    const state = await applyCommand(USER, { type: 'prev' });
    expect(state.trackId).toBe('track-a');
    expect(state.positionMs).toBe(0);
  });

  it('next at last track with repeat=off → stays on last', async () => {
    await seedQueue('track-c', 'off');
    const state = await applyCommand(USER, { type: 'next' });
    expect(state.trackId).toBe('track-c');
  });

  it('next at last track with repeat=all → wraps to first', async () => {
    await seedQueue('track-c', 'all');
    const state = await applyCommand(USER, { type: 'next' });
    expect(state.trackId).toBe('track-a');
    expect(state.positionMs).toBe(0);
  });

  it('prev at first track with repeat=off → stays on first', async () => {
    await seedQueue('track-a', 'off');
    const state = await applyCommand(USER, { type: 'prev' });
    expect(state.trackId).toBe('track-a');
  });

  it('prev at first track with repeat=all → wraps to last', async () => {
    await seedQueue('track-a', 'all');
    const state = await applyCommand(USER, { type: 'prev' });
    expect(state.trackId).toBe('track-c');
    expect(state.positionMs).toBe(0);
  });

  it('next on empty queue → no crash, state unchanged', async () => {
    // `null`, not `undefined`: this is the stored ROW. The wire shape converts
    // (see the `toConnectPlaybackState` block, which still expects `undefined`)
    // — the two live on opposite sides of that mapping on purpose.
    await getOrCreateState(USER);
    const state = await applyCommand(USER, { type: 'next' });
    expect(state.trackId).toBeNull();
    expect(state.positionMs).toBe(0);
  });
});

describe('handleDeviceDisconnect — failover', () => {
  const D1 = 'device-d1';
  const D2 = 'device-d2';

  async function registerBoth() {
    await registerDevice(USER, { deviceId: D1, name: 'Web', type: 'web' });
    await registerDevice(USER, { deviceId: D2, name: 'Mobile', type: 'mobile' });
  }

  it('failover: d1 active disconnects → d2 becomes active, isPlaying stays true', async () => {
    await registerBoth();
    await setNowPlaying(USER, { trackId: 'track-t', deviceId: D1 });
    await applyCommand(USER, { type: 'seek', positionMs: 15000 });

    const state = await handleDeviceDisconnect(USER, D1);

    expect(state.activeDeviceId).toBe(D2);
    expect(state.isPlaying).toBe(true);
    expect(state.trackId).toBe('track-t');
    expect(state.positionMs).toBe(15000);
  });

  it('no other active device: disconnect d1 → paused, activeDeviceId CLEARED', async () => {
    // The one place the drizzle/Mongoose difference bites. The document version
    // assigned `undefined` and `.save()` turned it into `$unset`; an
    // `undefined` in a drizzle `set` is dropped from the UPDATE, which would
    // leave the departed device named as active on a paused state forever.
    // Asserted against the STORED row, not just the returned one.
    await registerDevice(USER, { deviceId: D1, name: 'Web', type: 'web' });
    await setNowPlaying(USER, { trackId: 'track-t', deviceId: D1 });
    expect((await storedState(USER)).activeDeviceId).toBe(D1);

    const state = await handleDeviceDisconnect(USER, D1);

    expect(state.isPlaying).toBe(false);
    expect(state.activeDeviceId).toBeNull();

    const stored = await storedState(USER);
    expect(stored.isPlaying).toBe(false);
    expect(stored.activeDeviceId).toBeNull();
  });

  it('non-active device disconnects → activeDeviceId stays d1, isPlaying unchanged', async () => {
    await registerBoth();
    await setNowPlaying(USER, { trackId: 'track-t', deviceId: D1 });

    const state = await handleDeviceDisconnect(USER, D2);

    expect(state.activeDeviceId).toBe(D1);
    expect(state.isPlaying).toBe(true);
  });
});

describe('updateProgress', () => {
  it('active device updates positionMs', async () => {
    await setNowPlaying(USER, { trackId: 'track-abc', deviceId: 'device-d1' });
    const state = await updateProgress(USER, 'device-d1', 12000, true);

    expect(state.positionMs).toBe(12000);
    expect(state.isPlaying).toBe(true);
  });

  it('non-active device call is ignored (positionMs unchanged)', async () => {
    await setNowPlaying(USER, { trackId: 'track-abc', deviceId: 'device-d1' });
    await updateProgress(USER, 'device-d1', 5000);

    // A different device reports position — must be ignored
    const state = await updateProgress(USER, 'device-d2', 99999);
    expect(state.positionMs).toBe(5000);
  });

  it('updateProgress clamps positionMs to ≥0', async () => {
    await setNowPlaying(USER, { trackId: 'track-abc', deviceId: 'device-d1' });
    const state = await updateProgress(USER, 'device-d1', -100);
    expect(state.positionMs).toBe(0);
  });
});

describe('toConnectPlaybackState', () => {
  it('maps every field, with updatedAt serialized as an ISO string', async () => {
    await setNowPlaying(USER, {
      trackId: 'track-abc',
      source: 'cc',
      queue: ['track-abc', 'track-def'],
      contextType: 'album',
      contextId: 'album-1',
      deviceId: 'device-web',
    });
    await applyCommand(USER, { type: 'seek', positionMs: 42000 });
    await applyCommand(USER, { type: 'shuffle', shuffle: true });
    await applyCommand(USER, { type: 'repeat', repeat: 'all' });
    const state = await applyCommand(USER, { type: 'volume', volume: 0.4 });

    const connect = toConnectPlaybackState(state);

    expect(connect).toEqual({
      trackId: 'track-abc',
      source: 'cc',
      positionMs: 42000,
      isPlaying: true,
      queue: ['track-abc', 'track-def'],
      contextType: 'album',
      contextId: 'album-1',
      repeat: 'all',
      shuffle: true,
      volume: 0.4,
      activeDeviceId: 'device-web',
      updatedAt: state.updatedAt.toISOString(),
    });
    expect(typeof connect.updatedAt).toBe('string');
    expect(new Date(connect.updatedAt).toISOString()).toBe(connect.updatedAt);
  });

  it('carries through defaults for a freshly created state (no track, no active device)', async () => {
    const state = await getOrCreateState(USER);

    const connect = toConnectPlaybackState(state);

    expect(connect.trackId).toBeUndefined();
    expect(connect.source).toBeUndefined();
    expect(connect.contextType).toBeUndefined();
    expect(connect.contextId).toBeUndefined();
    expect(connect.activeDeviceId).toBeUndefined();
    expect(connect.positionMs).toBe(0);
    expect(connect.isPlaying).toBe(false);
    expect(connect.queue).toEqual([]);
    expect(connect.repeat).toBe('off');
    expect(connect.shuffle).toBe(false);
    expect(connect.volume).toBe(1);
    expect(typeof connect.updatedAt).toBe('string');
  });
});
