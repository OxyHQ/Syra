import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useOxy } from '@oxyhq/services';
import { playerSocketService } from '@/services/playerSocketService';
import { oxyServices } from '@/lib/oxyServices';
import { deviceDisplayName, deviceTypeForPlatform } from '@/utils/device';
import { getDeviceId } from '@/utils/deviceId';

/** Heartbeat interval — 30 s keeps the device marked active without flooding. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Standard capabilities advertised by the web / native Syra client. */
const CLIENT_CAPABILITIES = ['play', 'pause', 'seek', 'volume', 'next', 'prev', 'transfer'];

/**
 * App-root presence side-effect for Syra Connect.
 *
 * Once the Oxy session is ready (`canUsePrivateApi`), this opens the shared
 * `/player` socket, registers this device, and keeps it marked active with a
 * periodic heartbeat. Mounting it near the app root guarantees the socket is
 * live before any screen (e.g. the device picker via `useConnect`) needs the
 * device list.
 *
 * Connection is gated on `canUsePrivateApi` (Oxy cold-boot gating): the socket
 * is never opened before the SDK has restored a usable session, which would
 * fail auth. The socket's auth callback resolves a fresh access token on every
 * (re)connection.
 */
export function usePlayerPresence(): void {
  const { user, canUsePrivateApi } = useOxy();
  const userId = user?.id;

  useEffect(() => {
    if (!canUsePrivateApi || !userId) return;

    playerSocketService.connect(userId, () => oxyServices.getAccessToken());

    let cancelled = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      const deviceId = await getDeviceId();
      if (cancelled) return;

      playerSocketService.emitDeviceRegister({
        deviceId,
        name: deviceDisplayName(Platform.OS),
        type: deviceTypeForPlatform(Platform.OS),
        capabilities: CLIENT_CAPABILITIES,
      });

      heartbeat = setInterval(() => {
        playerSocketService.emitHeartbeat(deviceId);
      }, HEARTBEAT_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      playerSocketService.disconnect();
    };
  }, [canUsePrivateApi, userId]);
}
