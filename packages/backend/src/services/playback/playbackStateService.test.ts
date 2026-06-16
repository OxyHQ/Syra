import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { PlaybackStateModel } from '../../models/PlaybackState';
import {
  getOrCreateState,
  setNowPlaying,
  applyCommand,
  updateProgress,
} from './playbackStateService';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const USER = 'user-state-test';

describe('getOrCreateState', () => {
  it('creates a state doc with defaults', async () => {
    const state = await getOrCreateState(USER);

    expect(state.oxyUserId).toBe(USER);
    expect(state.positionMs).toBe(0);
    expect(state.isPlaying).toBe(false);
    expect(state.volume).toBe(1);
    expect(state.repeat).toBe('off');
    expect(state.shuffle).toBe(false);
    expect(state.queue).toEqual([]);
  });

  it('is idempotent — second call returns same doc, count stays 1', async () => {
    await getOrCreateState(USER);
    await getOrCreateState(USER);

    const count = await PlaybackStateModel.countDocuments({ oxyUserId: USER });
    expect(count).toBe(1);
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
    await getOrCreateState(USER);
    const state = await applyCommand(USER, { type: 'next' });
    expect(state.trackId).toBeUndefined();
    expect(state.positionMs).toBe(0);
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
