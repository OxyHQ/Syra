import { randomUUID } from 'expo-crypto';
import { Storage } from './storage';

const DEVICE_ID_STORAGE_KEY = 'syra:deviceId';

/**
 * Return a stable device ID for this installation.
 *
 * Generated once on first call via expo-crypto's randomUUID and persisted in
 * AsyncStorage. Subsequent calls return the same ID without regenerating.
 */
export async function getDeviceId(): Promise<string> {
  const stored = await Storage.get<string>(DEVICE_ID_STORAGE_KEY);
  if (stored !== null) {
    return stored;
  }

  const id = randomUUID();
  await Storage.set(DEVICE_ID_STORAGE_KEY, id);
  return id;
}
