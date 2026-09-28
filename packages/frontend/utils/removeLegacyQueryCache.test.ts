const mockStore = new Map<string, string>([
  ['syra-react-query-cache', 'old'],
  ['syra-react-query-cache:user:alice', 'library'],
  ['syra-react-query-active-scope', 'user:alice'],
  ['syra.ui-preferences', 'kept'],
]);

jest.mock('@react-native-async-storage/async-storage', () => ({
  getAllKeys: async () => [...mockStore.keys()],
  multiRemove: async (keys: string[]) => {
    for (const key of keys) mockStore.delete(key);
  },
}));

import { removeLegacyQueryCache } from './removeLegacyQueryCache';

describe('legacy Syra query snapshots', () => {
  it('deletes every snapshot Syra persisted itself, and nothing else', async () => {
    await removeLegacyQueryCache();
    expect([...mockStore.keys()]).toEqual(['syra.ui-preferences']);
  });
});
