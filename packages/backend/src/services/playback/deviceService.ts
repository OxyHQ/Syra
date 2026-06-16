import type { DeviceType } from '@syra/shared-types';
import { DeviceModel, IDevice } from '../../models/Device';

export interface RegisterDeviceInput {
  deviceId: string;
  name: string;
  type: DeviceType;
  capabilities?: string[];
}

/**
 * Register or update a device for the given user.
 * Uses upsert on (oxyUserId, deviceId) so re-registration updates fields
 * rather than creating a duplicate.
 */
export async function registerDevice(
  userId: string,
  input: RegisterDeviceInput,
): Promise<IDevice> {
  const doc = await DeviceModel.findOneAndUpdate(
    { oxyUserId: userId, deviceId: input.deviceId },
    {
      name: input.name,
      type: input.type,
      capabilities: input.capabilities ?? [],
      lastSeen: new Date(),
      isActive: true,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return doc as IDevice;
}

/**
 * List all devices for the user, most recently seen first.
 */
export async function listDevices(userId: string): Promise<IDevice[]> {
  return DeviceModel.find({ oxyUserId: userId }).sort({ lastSeen: -1 });
}

/**
 * Update lastSeen timestamp and confirm the device is active.
 * Called on regular intervals from the client to signal liveness.
 */
export async function heartbeat(userId: string, deviceId: string): Promise<void> {
  await DeviceModel.updateOne(
    { oxyUserId: userId, deviceId },
    { lastSeen: new Date(), isActive: true },
  );
}

/**
 * Mark a device as inactive (e.g. on disconnect or explicit sign-out).
 */
export async function markInactive(userId: string, deviceId: string): Promise<void> {
  await DeviceModel.updateOne(
    { oxyUserId: userId, deviceId },
    { isActive: false },
  );
}
