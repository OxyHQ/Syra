/**
 * Delete the query snapshots Syra persisted itself (`lib/queryPersister.ts`)
 * before `@oxy.so/services` 8.4 took persistence over (`accountQueries`).
 * Nothing reads them any more, but each can hold an account's library, so
 * leaving them in storage is not an option. Delete this file once those builds
 * are long gone.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const LEGACY_PREFIX = 'syra-react-query-';

export async function removeLegacyQueryCache(): Promise<void> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(LEGACY_PREFIX));
    if (keys.length > 0) await AsyncStorage.multiRemove(keys);
  } catch {
    // Storage unavailable: nothing was persisted there either.
  }
}
