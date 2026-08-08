import type { PlaybackCommand, CatalogSource, ConnectPlaybackState } from '@syra/shared-types';
import {
  findOrCreatePlaybackState,
  updatePlaybackState,
  type PlaybackStatePatch,
  type PlaybackStateRow,
} from '../../db/playback/playbackStates';
import { listDevices, markInactive } from './deviceService';

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Serialize the stored playback row into the wire-safe
 * {@link ConnectPlaybackState} broadcast over the `/player` socket. Keeping this
 * the single mapping point ensures every `playback:state` emit sends the exact
 * shape Syra Connect clients parse (field names, and `updatedAt` as an ISO
 * string rather than a `Date`).
 *
 * Every `?? undefined` is a real conversion, not defensive noise: these columns
 * are nullable and drizzle returns `null`, while the wire schema declares them
 * `.optional()`. JSON would carry a `null` through to clients that were
 * promised an absent key.
 */
export function toConnectPlaybackState(state: PlaybackStateRow): ConnectPlaybackState {
  return {
    trackId: state.trackId ?? undefined,
    source: state.source ?? undefined,
    positionMs: state.positionMs,
    isPlaying: state.isPlaying,
    queue: state.queue,
    contextType: state.contextType ?? undefined,
    contextId: state.contextId ?? undefined,
    repeat: state.repeat,
    shuffle: state.shuffle,
    volume: state.volume,
    activeDeviceId: state.activeDeviceId ?? undefined,
    updatedAt: state.updatedAt.toISOString(),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the user's playback state, creating it with defaults if it doesn't
 * exist yet. Idempotent — always returns a single persistent row per user.
 */
export async function getOrCreateState(userId: string): Promise<PlaybackStateRow> {
  return findOrCreatePlaybackState(userId);
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
 *
 * Each optional input is spread in only when it was supplied, which is how
 * "leave the stored value alone" is spelled against a drizzle `set` — the
 * literal port of `if (input.x !== undefined) state.x = input.x`.
 */
export async function setNowPlaying(
  userId: string,
  input: SetNowPlayingInput,
): Promise<PlaybackStateRow> {
  await getOrCreateState(userId);

  return updatePlaybackState(userId, {
    trackId: input.trackId,
    ...(input.source !== undefined && { source: input.source }),
    ...(input.queue !== undefined && { queue: input.queue }),
    ...(input.contextType !== undefined && { contextType: input.contextType }),
    ...(input.contextId !== undefined && { contextId: input.contextId }),
    positionMs: 0,
    isPlaying: true,
    ...(input.deviceId !== undefined && { activeDeviceId: input.deviceId }),
  });
}

/**
 * Apply a playback command to the user's authoritative state.
 *
 * Commands are idempotent descriptions of intent; the server is the single
 * source of truth. All mutations go through this function.
 *
 * A command that changes nothing (an empty queue's `next`, a `volume` with no
 * volume) leaves `patch` empty and returns the state unwritten — the Mongoose
 * version called `.save()` regardless, which for a document with no modified
 * paths was likewise a no-op write. What must NOT change is `updated_at`: it
 * orders states on the client, so bumping it for a command that did nothing
 * would make two clients disagree about which state is newer.
 */
export async function applyCommand(
  userId: string,
  command: PlaybackCommand,
): Promise<PlaybackStateRow> {
  const state = await getOrCreateState(userId);
  const patch: PlaybackStatePatch = {};

  switch (command.type) {
    case 'play':
      patch.isPlaying = true;
      break;

    case 'pause':
      patch.isPlaying = false;
      break;

    case 'seek':
      patch.positionMs = clamp(command.positionMs ?? state.positionMs, 0, Infinity);
      break;

    case 'volume':
      if (command.volume !== undefined) {
        patch.volume = clamp(command.volume, 0, 1);
      }
      break;

    case 'shuffle':
      patch.shuffle = command.shuffle !== undefined ? command.shuffle : !state.shuffle;
      break;

    case 'repeat':
      if (command.repeat !== undefined) patch.repeat = command.repeat;
      break;

    case 'transfer':
      // Spotify-Connect handoff: new device resumes at same trackId + positionMs.
      // Only update activeDeviceId if a target device was specified.
      if (command.deviceId !== undefined) {
        patch.activeDeviceId = command.deviceId;
      }
      break;

    case 'next': {
      const queue = state.queue;
      if (queue.length === 0) break;
      const idx = state.trackId ? queue.indexOf(state.trackId) : -1;
      const atEnd = idx === queue.length - 1 || idx === -1;
      if (atEnd) {
        if (state.repeat === 'all') {
          patch.trackId = queue[0];
          patch.positionMs = 0;
        }
        // repeat off/one: stay on last track (no crash)
      } else {
        patch.trackId = queue[idx + 1];
        patch.positionMs = 0;
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
          patch.trackId = queue[queue.length - 1];
          patch.positionMs = 0;
        }
        // repeat off/one: stay on first track
      } else {
        patch.trackId = queue[idx - 1];
        patch.positionMs = 0;
      }
      break;
    }
  }

  if (Object.keys(patch).length === 0) return state;

  return updatePlaybackState(userId, patch);
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
 *
 * The `activeDeviceId: null` in the no-failover branch is the one place in this
 * vertical where the drizzle/Mongoose difference bites. The document version
 * assigned `undefined` and `.save()` turned that into `$unset`; an `undefined`
 * here would be dropped from the UPDATE, leaving a disconnected device named as
 * active on a paused state forever. See `db/playback/playbackStates.ts`.
 */
export async function handleDeviceDisconnect(
  userId: string,
  deviceId: string,
): Promise<PlaybackStateRow> {
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
    // isPlaying, trackId, positionMs preserved — other device picks up seamlessly
    return updatePlaybackState(userId, { activeDeviceId: other.deviceId });
  }

  return updatePlaybackState(userId, { isPlaying: false, activeDeviceId: null });
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
): Promise<PlaybackStateRow> {
  const state = await getOrCreateState(userId);

  if (deviceId !== state.activeDeviceId) {
    // Non-active device — return current state unchanged
    return state;
  }

  return updatePlaybackState(userId, {
    positionMs: clamp(positionMs, 0, Infinity),
    ...(isPlaying !== undefined && { isPlaying }),
  });
}
