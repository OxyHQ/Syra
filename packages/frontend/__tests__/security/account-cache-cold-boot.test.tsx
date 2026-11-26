/**
 * A cold boot as B on a device that also holds A's persisted queries.
 *
 * Its own file, so the app's `queryClient` and `accountQueryCache` start as
 * they do in a new process: nothing in memory, both accounts' blobs on disk.
 * B's first paint is B's own cached library (offline: B's reads never answer),
 * and A's blob is neither hydrated nor touched. A blob written by another
 * build restores nothing.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LIBRARY_QUERY_KEY, useLibrary } from '@/hooks/useLibrary';
import {
  accountQueryStorageKey,
  createAccountQueryCache,
  followOxyRuntime,
  snapshot,
} from '@/lib/accountQueryCache';
import { accountQueryCache, queryClient } from '@/lib/queryClient';
import {
  createRuntime,
  type FakeRuntime,
  membership,
  memoryStorage,
  trackQueries,
  waitUntil,
} from '@/test-utils/accountCache';

let mockRuntime: FakeRuntime;

// The storage is the test's own (`followOxyRuntime(..., storage)`).
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: {} }));
jest.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => jest.requireActual('@/test-utils/accountCache').useFakeOxy(mockRuntime),
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock('@/utils/api', () => ({ getErrorStatus: () => undefined }));
// Offline: no read ever answers, so whatever shows came from disk.
jest.mock('@/services/libraryService', () => ({
  libraryService: { getLibrary: () => new Promise<never>(() => undefined) },
}));

/** A blob exactly as the account cache writes one, for `marker`'s data. */
function blobFor(marker: string, buster?: string): string {
  const seed = new QueryClient();
  seed.setQueryData(LIBRARY_QUERY_KEY, membership(marker));
  seed.setQueryData(['playlist', 'shared-playlist'], { name: `${marker}-playlist` });
  const blob = snapshot(seed, buster);
  seed.clear();
  return blob;
}

function Probe() {
  const { membership: library } = useLibrary();
  return <Text testID="probe">{library.likedTracks.join('|')}</Text>;
}

let renderer: ReactTestRenderer | undefined;
let unfollow: () => void = () => undefined;
const queries = trackQueries(queryClient);

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  unfollow();
  unfollow = () => undefined;
  // Cancels every timer a query holds, so a failed run cannot keep Jest alive.
  queryClient.clear();
  queries.destroyAll();
});
const probe = () => String(renderer!.root.findByProps({ testID: 'probe' }).props.children ?? '');

it('boots as B with A’s persisted queries on the device: B paints its own cache, never A’s', async () => {
  const aBlob = blobFor('A-private');
  const storage = memoryStorage({
    [accountQueryStorageKey('A')]: aBlob,
    [accountQueryStorageKey('B')]: blobFor('B-own'),
  });
  mockRuntime = createRuntime('B');
  unfollow = followOxyRuntime(accountQueryCache, mockRuntime, storage);

  await act(async () => {
    renderer = create(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });

  await waitUntil(act, () => probe() === 'B-own-track');
  const held = JSON.stringify(
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  );
  expect(held).toContain('B-own-playlist');
  expect(held).not.toContain('A-private');
  expect(queryClient.getQueryData(['playlist', 'shared-playlist'])).toEqual({
    name: 'B-own-playlist',
  });

  // A's blob was never read into memory nor rewritten.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  });
  expect(storage.values.get(accountQueryStorageKey('A'))).toBe(aBlob);
  expect(storage.values.get(accountQueryStorageKey('B'))).not.toContain('A-private');
});

it('restores nothing from a blob another build wrote', async () => {
  const client = new QueryClient();
  const cache = createAccountQueryCache(client, 'build-2');
  const storage = memoryStorage({ [accountQueryStorageKey('B')]: blobFor('B-old', 'build-1') });
  unfollow = followOxyRuntime(cache, createRuntime('B'), storage);

  try {
    await waitUntil(act, () => cache.isReady());
    expect(client.getQueryData(LIBRARY_QUERY_KEY)).toBeUndefined();
  } finally {
    client.clear();
  }
});
