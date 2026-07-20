import { useCallback, useEffect, useState } from 'react';
import { useOxy } from '@oxyhq/services';
import type { Device, PlaybackCommand } from '@syra/shared-types';
import { playerSocketService } from '@/services/playerSocketService';

/**
 * How long to wait for the server's first `device:list` before giving up and
 * surfacing a retryable error. The socket is shared and may still be connecting
 * when this hook mounts, so the window has to cover a cold connect.
 */
const DEVICE_LIST_TIMEOUT_MS = 8000;

/**
 * Cadence for re-asking the server for the list until it answers. Covers the
 * case where the socket connects *after* the first request was emitted (the
 * emit is dropped while disconnected), without waiting for a full reconnect.
 */
const DEVICE_LIST_RETRY_INTERVAL_MS = 1500;

/** Stable empty list so consumers don't see a new array identity every render. */
const NO_DEVICES: Device[] = [];

/** Terminal-by-construction state of the device list. */
export type ConnectStatus = 'loading' | 'ready' | 'error' | 'signed-out';

export interface UseConnectResult {
  /** Registered devices for the current user, most-recently-seen first. */
  devices: Device[];
  /** Which of the four terminal states the device list is in. */
  status: ConnectStatus;
  /** True only while the initial device list is still outstanding. */
  isLoading: boolean;
  /** User-facing reason the list is unavailable, set only when `status` is `error`. */
  error: string | null;
  /** Re-request the device list after an error. */
  retry: () => void;
  /** Send an arbitrary playback command to the server. */
  sendCommand: (command: PlaybackCommand) => void;
  /** Transfer playback to a different device. */
  transferTo: (deviceId: string) => void;
}

/**
 * Outcome of one device-list attempt, stamped with the attempt that produced it.
 * The stamp is what lets a retry invalidate the previous outcome by derivation
 * instead of a synchronous reset inside the effect.
 */
interface DeviceListAttempt {
  attempt: number;
  devices: Device[] | null;
  error: string | null;
}

/**
 * Subscribe to the live Syra Connect device list for the current user.
 *
 * The shared `/player` socket, this device's registration, and heartbeats are
 * owned by {@link usePlayerPresence} at the app root. This hook only listens for
 * the device list and asks the server to send the current one on mount, so the
 * subscription persists across socket reconnects.
 *
 * Every path reaches a terminal state: signed-out users are told so immediately,
 * and a socket that never connects or a server that never answers lands on a
 * retryable error instead of an endless spinner. A list that arrives late still
 * wins — the subscription outlives the timeout, so the error self-heals.
 */
export function useConnect(): UseConnectResult {
  const { canUsePrivateApi, isPrivateApiPending } = useOxy();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<DeviceListAttempt>({
    attempt: 0,
    devices: null,
    error: null,
  });

  useEffect(() => {
    // Nothing to wait on until Oxy cold boot settles, and a signed-out user has
    // no device list to fetch — both are derived below, no subscription needed.
    if (isPrivateApiPending || !canUsePrivateApi) {
      return;
    }

    let poll: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stopTimers = () => {
      if (poll !== undefined) clearInterval(poll);
      if (deadline !== undefined) clearTimeout(deadline);
      poll = undefined;
      deadline = undefined;
    };

    const unsubscribe = playerSocketService.onDeviceList((list) => {
      stopTimers();
      setResult({ attempt, devices: list, error: null });
    });

    // The socket is usually already live (usePlayerPresence connected it at the
    // app root); request the current list so it populates immediately.
    playerSocketService.requestDeviceList();
    poll = setInterval(() => {
      playerSocketService.requestDeviceList();
    }, DEVICE_LIST_RETRY_INTERVAL_MS);

    deadline = setTimeout(() => {
      stopTimers();
      // Read the live socket state here, in a callback — never in a memoized
      // render position, where the React Compiler would freeze the first read.
      setResult({
        attempt,
        devices: null,
        error: playerSocketService.connected
          ? "Your devices didn't load. Syra Connect isn't responding right now."
          : "Can't reach Syra Connect. Check your connection and try again.",
      });
    }, DEVICE_LIST_TIMEOUT_MS);

    return () => {
      stopTimers();
      unsubscribe();
    };
  }, [attempt, canUsePrivateApi, isPrivateApiPending]);

  // A result from a superseded attempt is ignored, which puts a retry straight
  // back into `loading` without the effect having to reset state.
  const isCurrentAttempt = result.attempt === attempt;
  const loadedDevices = isCurrentAttempt ? result.devices : null;
  const attemptError = isCurrentAttempt ? result.error : null;

  const status: ConnectStatus = isPrivateApiPending
    ? 'loading'
    : !canUsePrivateApi
      ? 'signed-out'
      : attemptError
        ? 'error'
        : loadedDevices
          ? 'ready'
          : 'loading';

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const sendCommand = useCallback((command: PlaybackCommand) => {
    playerSocketService.emitPlaybackCommand(command);
  }, []);

  const transferTo = useCallback((targetDeviceId: string) => {
    playerSocketService.emitPlaybackCommand({ type: 'transfer', deviceId: targetDeviceId });
  }, []);

  return {
    devices: status === 'ready' && loadedDevices ? loadedDevices : NO_DEVICES,
    status,
    isLoading: status === 'loading',
    error: status === 'error' ? attemptError : null,
    retry,
    sendCommand,
    transferTo,
  };
}
