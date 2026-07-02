import type { PlaybackCommand, CatalogSource, ConnectPlaybackState } from '@syra/shared-types';
import { PlaybackStateModel, IPlaybackState } from '../../models/PlaybackState';
import { listDevices, markInactive } from './deviceService';

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Serialize the persisted Mongoose playback document into the wire-safe
 * {@link ConnectPlaybackState} broadcast over the `/player` socket. Keeping this
 * the single mapping point ensures every `playback:state` emit sends the exact
 * shape Syra Connect clients parse (field names, and `updatedAt` as an ISO
 * string rather than a `Date`).
 */
export function toConnectPlaybackState(state: IPlaybackState): ConnectPlaybackState {
  return {
    trackId: state.trackId,
    source: state.source,
    positionMs: state.positionMs,
    isPlaying: state.isPlaying,
    queue: state.queue,
    contextType: state.contextType,
    contextId: state.contextId,
    repeat: state.repeat,
    shuffle: state.shuffle,
    volume: state.volume,
    activeDeviceId: state.activeDeviceId,
    updatedAt: state.updatedAt.toISOString(),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the user's playback state, creating it with defaults if it doesn't
 * exist yet. Idempotent — always returns a single persistent doc per user.
 */
export async function getOrCreateState(userId: string): Promise<IPlaybackState> {
  const existing = await PlaybackStateModel.findOne({ oxyUserId: userId });
  if (existing) return existing;

  return PlaybackStateModel.create({ oxyUserId: userId });
}

export interface SetNowPlayingInput {
  trackId: string;
  source?: CatalogSource;
  queue?: string[];
  contextType?: string;
  contextId?: string;
  deviceId?: string;
}

/**
 * Start playing a new track. Resets position to 0 and sets isPlaying = true.
 * Preserves the existing activeDeviceId when no deviceId is provided.
 */
export async function setNowPlaying(
  userId: string,
  input: SetNowPlayingInput,
): Promise<IPlaybackState> {
  const state = await getOrCreateState(userId);

  state.trackId = input.trackId;
  if (input.source !== undefined) state.source = input.source;
  if (input.queue !== undefined) state.queue = input.queue;
  if (input.contextType !== undefined) state.contextType = input.contextType;
  if (input.contextId !== undefined) state.contextId = input.contextId;
  state.positionMs = 0;
  state.isPlaying = true;
  if (input.deviceId !== undefined) state.activeDeviceId = input.deviceId;

  return state.save();
}

/**
 * Apply a playback command to the user's authoritative state.
 *
 * Commands are idempotent descriptions of intent; the server is the single
 * source of truth. All mutations go through this function.
 */
export async function applyCommand(
  userId: string,
  command: PlaybackCommand,
): Promise<IPlaybackState> {
  const state = await getOrCreateState(userId);

  switch (command.type) {
    case 'play':
      state.isPlaying = true;
      break;

    case 'pause':
      state.isPlaying = false;
      break;

    case 'seek':
      state.positionMs = clamp(command.positionMs ?? state.positionMs, 0, Infinity);
      break;

    case 'volume':
      if (command.volume !== undefined) {
        state.volume = clamp(command.volume, 0, 1);
      }
      break;

    case 'shuffle':
      state.shuffle = command.shuffle !== undefined ? command.shuffle : !state.shuffle;
      break;

    case 'repeat':
      if (command.repeat !== undefined) state.repeat = command.repeat;
      break;

    case 'transfer':
      // Spotify-Connect handoff: new device resumes at same trackId + positionMs.
      // Only update activeDeviceId if a target device was specified.
      if (command.deviceId !== undefined) {
        state.activeDeviceId = command.deviceId;
      }
      break;

    case 'next': {
      const queue = state.queue;
      if (queue.length === 0) break;
      const idx = state.trackId ? queue.indexOf(state.trackId) : -1;
      const atEnd = idx === queue.length - 1 || idx === -1;
      if (atEnd) {
        if (state.repeat === 'all') {
          state.trackId = queue[0];
          state.positionMs = 0;
        }
        // repeat off/one: stay on last track (no crash)
      } else {
        state.trackId = queue[idx + 1];
        state.positionMs = 0;
      }
      break;
    }

    case 'prev': {
      const queue = state.queue;
      if (queue.length === 0) break;
      const idx = state.trackId ? queue.indexOf(state.trackId) : -1;
      const atStart = idx <= 0;
      if (atStart) {
        if (state.repeat === 'all') {
          state.trackId = queue[queue.length - 1];
          state.positionMs = 0;
        }
        // repeat off/one: stay on first track
      } else {
        state.trackId = queue[idx - 1];
        state.positionMs = 0;
      }
      break;
    }
  }

  return state.save();
}

/**
 * Handle a device going offline.
 *
 * Marks the device inactive then, if it was the active playback device,
 * attempts a failover:
 *  - Another still-active device exists → promote it (keep trackId + positionMs).
 *  - No other active devices → pause playback and clear activeDeviceId.
 *
 * If the disconnected device was not the active device the playback state is
 * left untouched (only the device registry is updated).
 */
export async function handleDeviceDisconnect(
  userId: string,
  deviceId: string,
): Promise<IPlaybackState> {
  await markInactive(userId, deviceId);

  const state = await getOrCreateState(userId);

  if (state.activeDeviceId !== deviceId) {
    // Non-active device disconnected — state unaffected
    return state;
  }

  // Active device disconnected — try to fail over to another active device
  const devices = await listDevices(userId);
  const other = devices.find((d) => d.isActive && d.deviceId !== deviceId);

  if (other) {
    state.activeDeviceId = other.deviceId;
    // isPlaying, trackId, positionMs preserved — other device picks up seamlessly
  } else {
    state.isPlaying = false;
    state.activeDeviceId = undefined;
  }

  return state.save();
}

/**
 * Update playback position reported by a device.
 *
 * Only the active device may advance the server-authoritative position —
 * reports from non-active devices are silently ignored to prevent stale
 * or background devices from corrupting the shared state.
 */
export async function updateProgress(
  userId: string,
  deviceId: string,
  positionMs: number,
  isPlaying?: boolean,
): Promise<IPlaybackState> {
  const state = await getOrCreateState(userId);

  if (deviceId !== state.activeDeviceId) {
    // Non-active device — return current state unchanged
    return state;
  }

  state.positionMs = clamp(positionMs, 0, Infinity);
  if (isPlaying !== undefined) state.isPlaying = isPlaying;

  return state.save();
}
