import type { Device } from '@syra/shared-types';
import {
  findDevicesForUser,
  setDeviceActive,
  toDevice,
  touchDevice,
  upsertDevice,
  type RegisterDeviceInput,
} from '../../db/playback/devices';
import { devices } from '../../db/schema/library';

export type { RegisterDeviceInput };

export type DeviceRow = typeof devices.$inferSelect;

/**
 * Register or update a device for the given user.
 * Upserts on (oxyUserId, deviceId) so re-registration updates fields
 * rather than creating a duplicate.
 *
 * Returns the stored ROW, not the wire shape — a write reports what it wrote,
 * including the columns (`oxyUserId`, `createdAt`) that never leave the server.
 * Contrast {@link listDevices}.
 */
export async function registerDevice(
  userId: string,
  input: RegisterDeviceInput,
): Promise<DeviceRow> {
  return upsertDevice(userId, input);
}

/**
 * List all devices for the user, most recently seen first.
 *
 * Returns the WIRE shape, because this result is broadcast verbatim as the
 * `/player` socket's `device:list` payload (`sockets/playerSocket.ts`, three
 * emit sites). `@syra/shared-types`' `deviceSchema` is that payload's declared
 * contract; the Mongoose version emitted raw documents, so clients received
 * `_id`/`__v` they were never promised and a `Date` where the schema says
 * string. Mapping once here is what makes the three emits correct rather than
 * three chances to forget.
 */
export async function listDevices(userId: string): Promise<Device[]> {
  const rows = await findDevicesForUser(userId);
  return rows.map(toDevice);
}

/**
 * Update lastSeen timestamp and confirm the device is active.
 * Called on regular intervals from the client to signal liveness.
 */
export async function heartbeat(userId: string, deviceId: string): Promise<void> {
  await touchDevice(userId, deviceId);
}

/**
 * Mark a device as inactive (e.g. on disconnect or explicit sign-out).
 */
export async function markInactive(userId: string, deviceId: string): Promise<void> {
  await setDeviceActive(userId, deviceId, false);
}
