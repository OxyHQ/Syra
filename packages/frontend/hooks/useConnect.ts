import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useOxy } from '@oxyhq/services';
import type { Device, PlaybackCommand } from '@syra/shared-types';
import { playerSocketService } from '@/services/playerSocketService';
import { deviceTypeForPlatform, deviceDisplayName } from '@/utils/device';
import { getDeviceId } from '@/utils/deviceId';

/** Heartbeat interval — 30 s keeps the device marked active without flooding. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Standard capabilities advertised by the web / native Syra client. */
const CLIENT_CAPABILITIES = ['play', 'pause', 'seek', 'volume', 'next', 'prev', 'transfer'];

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
 * Register this device with the Syra Connect system and subscribe to the live
 * device list via the player socket.
 *
 * Registration happens once per authenticated session; a heartbeat is emitted
 * every HEARTBEAT_INTERVAL_MS to keep the device marked active server-side.
 */
export function useConnect(): UseConnectResult {
  const { user, isAuthenticated } = useOxy();
  const [devices, setDevices] = useState<Device[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const deviceIdRef = useRef<string | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const registerDevice = useCallback(async () => {
    if (!isAuthenticated || !user) return;

    const id = await getDeviceId();
    deviceIdRef.current = id;

    playerSocketService.emitDeviceRegister({
      deviceId: id,
      name: deviceDisplayName(Platform.OS),
      type: deviceTypeForPlatform(Platform.OS),
      capabilities: CLIENT_CAPABILITIES,
    });
  }, [isAuthenticated, user]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const unsubscribe = playerSocketService.onDeviceList((list) => {
      setDevices(list);
      setIsLoading(false);
    });

    void registerDevice();

    heartbeatRef.current = setInterval(() => {
      if (deviceIdRef.current !== null) {
        playerSocketService.emitHeartbeat(deviceIdRef.current);
      }
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      unsubscribe();
      if (heartbeatRef.current !== null) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [isAuthenticated, registerDevice]);

  const sendCommand = useCallback((command: PlaybackCommand) => {
    playerSocketService.emitPlaybackCommand(command);
  }, []);

  const transferTo = useCallback((targetDeviceId: string) => {
    playerSocketService.emitPlaybackCommand({ type: 'transfer', deviceId: targetDeviceId });
  }, []);

  return { devices, isLoading, sendCommand, transferTo };
}
