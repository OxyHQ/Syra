/**
 * `devices` reads and writes — the registry behind the `/player` socket's
 * `device:register`, `device:list` and `heartbeat` events.
 *
 * ## The upsert is the whole point of this table
 *
 * `devices_oxy_user_id_device_id_key` is what makes re-registering the same
 * client update its row instead of adding a second one, and it is the conflict
 * target every write here uses. `deviceId` is client-generated and identifies
 * the row rather than referencing anything (see `schema/library.ts`), so the
 * pair is the only key that means "this browser, this account".
 *
 * ## `toDevice` exists because the socket emits these straight to clients
 *
 * `sockets/playerSocket.ts` broadcasts the result of {@link findDevicesForUser}
 * as the `device:list` payload, so whatever shape this module returns IS the
 * wire contract. `@syra/shared-types`' `deviceSchema` declares that contract —
 * `{ id?, deviceId, name, type, capabilities, lastSeen, isActive }` with
 * `lastSeen` a STRING — and the Mongoose version satisfied neither half: it
 * emitted the raw document, so clients received `_id` and `__v` they were never
 * promised and a `Date` where the schema says string. Mapping here rather than
 * in the socket keeps the one place that knows the row shape responsible for
 * the one shape that leaves it.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { Device, DeviceType } from '@syra/shared-types';
import { getDb } from '../postgres';
import { devices } from '../schema/library';

export interface RegisterDeviceInput {
  deviceId: string;
  name: string;
  type: DeviceType;
  capabilities?: string[];
}

type DeviceRow = typeof devices.$inferSelect;

/** One stored row as the `deviceSchema` shape clients are promised. */
export function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    deviceId: row.deviceId,
    name: row.name,
    type: row.type,
    capabilities: row.capabilities,
    lastSeen: row.lastSeen.toISOString(),
    isActive: row.isActive,
  };
}

/**
 * Register a device, or update the one already registered under this
 * `(oxyUserId, deviceId)` pair.
 *
 * `capabilities` defaults to `[]` on BOTH sides of the upsert, not just the
 * insert. Mongoose's `findOneAndUpdate` set the field on every call because the
 * update document always carried it, so a re-register that omits capabilities
 * CLEARED them; keeping that in the conflict branch preserves the behaviour
 * rather than silently making the field sticky.
 *
 * `lastSeen` is stamped explicitly instead of relying on the column default,
 * which only applies to an insert.
 */
export async function upsertDevice(
  oxyUserId: string,
  input: RegisterDeviceInput
): Promise<DeviceRow> {
  const values = {
    name: input.name,
    type: input.type,
    capabilities: input.capabilities ?? [],
    lastSeen: new Date(),
    isActive: true,
  };

  const [row] = await getDb()
    .insert(devices)
    .values({ oxyUserId, deviceId: input.deviceId, ...values })
    .onConflictDoUpdate({ target: [devices.oxyUserId, devices.deviceId], set: values })
    .returning();

  return row;
}

/** Every device this account has registered, most recently seen first. */
export async function findDevicesForUser(oxyUserId: string): Promise<DeviceRow[]> {
  return getDb()
    .select()
    .from(devices)
    .where(eq(devices.oxyUserId, oxyUserId))
    .orderBy(desc(devices.lastSeen));
}

/**
 * Mark a device seen: bump `lastSeen` and assert it is active.
 *
 * A no-op when the pair names no row — the socket calls this on a timer and an
 * unregistered device is a client that has not sent `device:register` yet, not
 * an error worth throwing at a heartbeat.
 */
export async function touchDevice(oxyUserId: string, deviceId: string): Promise<void> {
  await getDb()
    .update(devices)
    .set({ lastSeen: new Date(), isActive: true })
    .where(and(eq(devices.oxyUserId, oxyUserId), eq(devices.deviceId, deviceId)));
}

/** Flip a device's active flag — disconnect sets false, nothing else writes it. */
export async function setDeviceActive(
  oxyUserId: string,
  deviceId: string,
  isActive: boolean
): Promise<void> {
  await getDb()
    .update(devices)
    .set({ isActive })
    .where(and(eq(devices.oxyUserId, oxyUserId), eq(devices.deviceId, deviceId)));
}
