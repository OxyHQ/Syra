import { useCallback, useEffect, useState } from 'react';
import { useOxy } from '@oxyhq/services';
import type { Device, PlaybackCommand } from '@syra/shared-types';
import { playerSocketService } from '@/services/playerSocketService';

export interface UseConnectResult {
  /** Registered devices for the current user, most-recently-seen first. */
  devices: Device[];
  /** True while the initial device list has not yet arrived. */
  isLoading: boolean;
  /** Send an arbitrary playback command to the server. */
  sendCommand: (command: PlaybackCommand) => void;
  /** Transfer playback to a different device. */
  transferTo: (deviceId: string) => void;
}

/**
 * Subscribe to the live Syra Connect device list for the current user.
 *
 * The shared `/player` socket, this device's registration, and heartbeats are
 * owned by {@link usePlayerPresence} at the app root. This hook only listens for
 * the device list and asks the server to send the current one on mount, so the
 * subscription persists across socket reconnects.
 */
export function useConnect(): UseConnectResult {
  const { canUsePrivateApi } = useOxy();
  const [devices, setDevices] = useState<Device[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!canUsePrivateApi) return;

    const unsubscribe = playerSocketService.onDeviceList((list) => {
      setDevices(list);
      setIsLoading(false);
    });

    // The socket is already live (usePlayerPresence connected it at the app
    // root); request the current list so it populates immediately.
    playerSocketService.requestDeviceList();

    return () => {
      unsubscribe();
    };
  }, [canUsePrivateApi]);

  const sendCommand = useCallback((command: PlaybackCommand) => {
    playerSocketService.emitPlaybackCommand(command);
  }, []);

  const transferTo = useCallback((targetDeviceId: string) => {
    playerSocketService.emitPlaybackCommand({ type: 'transfer', deviceId: targetDeviceId });
  }, []);

  return { devices, isLoading, sendCommand, transferTo };
}
