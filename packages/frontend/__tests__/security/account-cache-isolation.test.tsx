/**
 * Syra's query cache stays strictly per account on Services 15, where Syra owns
 * its React Query client and its account scoping (`lib/accountQueryCache.ts`).
 *
 * This runs the app's own wiring: the module `queryClient`, the
 * `accountQueryCache` it is scoped by, `followOxyRuntime`, and the real
 * `useLibrary`. Only the session runtime (published, then every subscriber
 * woken in one pass, as Services' `createOxyRuntime` does), the per-account
 * library service and the storage are fakes.
 *
 * `['library']` is not keyed by account, so it is the root a leak would show
 * on; `['search', ...]` is memory only. The story: A reads; a read for A is
 * still in flight when the session switches to B; A's late answer lands; B
 * reads its own; sign-out; A signs in again offline and gets its own cached
 * library back.
 */
import { useQuery } from '@tanstack/react-query';
import { memo } from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import { LIBRARY_QUERY_KEY, useLibrary } from '@/hooks/useLibrary';
import { accountQueryStorageKey, followOxyRuntime } from '@/lib/accountQueryCache';
import { accountQueryCache, queryClient } from '@/lib/queryClient';
import { libraryService } from '@/services/libraryService';
import {
  createRuntime,
  deferred,
  type FakeRuntime,
  membership,
  memoryStorage,
  trackQueries,
  waitUntil,
} from '@/test-utils/accountCache';

type Membership = ReturnType<typeof membership>;
const mockLibraries = new Map<string, () => Promise<Membership>>();
let mockRuntime: FakeRuntime;

jest.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => jest.requireActual('@/test-utils/accountCache').useFakeOxy(mockRuntime),
}));
// The storage is the test's own (`followOxyRuntime(..., storage)`).
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: {} }));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock('@/utils/api', () => ({ getErrorStatus: () => undefined }));
jest.mock('@/services/libraryService', () => ({
  // The bearer a request carries is the session's at the time it is made.
  libraryService: { getLibrary: () => mockLibraries.get(mockRuntime.current() ?? '')!() },
}));

function Probe() {
  const { membership: library } = useLibrary();
  const search = useQuery({
    queryKey: ['search', 'tracks', 'q'],
    queryFn: async () => `${mockRuntime.current()}-search-result`,
  });
  return <Text testID="probe">{[...library.likedTracks, search.data ?? ''].join('|')}</Text>;
}

/** Reads `['library']` from the cache and never re-renders for the session. */
const Bystander = memo(function Bystander() {
  const { data } = useQuery<Membership>({
    queryKey: LIBRARY_QUERY_KEY,
    queryFn: () => libraryService.getLibrary() as Promise<Membership>,
    enabled: false,
  });
  return <Text testID="bystander">{(data?.likedTracks ?? []).join('|')}</Text>;
});

/** Everything the client holds right now, whatever key it sits under. */
const held = () =>
  JSON.stringify(
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => [query.queryKey, query.state.data]),
  );

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
const text = (testID: string) =>
  String(renderer!.root.findByProps({ testID }).props.children ?? '');

it('never lets account A’s data be read, rendered or persisted for B: switch, late answer, sign-out', async () => {
  const storage = memoryStorage();
  mockRuntime = createRuntime('A');
  mockLibraries.set('A', async () => membership('A-private'));
  unfollow = followOxyRuntime(accountQueryCache, mockRuntime, storage);

  await act(async () => {
    renderer = create(
      <QueryClientProvider client={queryClient}>
        <Probe />
        <Bystander />
      </QueryClientProvider>,
    );
  });

  // A reads its library and a search.
  await waitUntil(act, () => text('probe') === 'A-private-track|A-search-result');
  expect(text('bystander')).toBe('A-private-track');

  // A read for A is still in flight when the session moves to B.
  const late = deferred<Membership>();
  mockLibraries.set('A', () => late.promise);
  await act(async () => {
    void queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY });
  });

  const bLibrary = deferred<Membership>();
  mockLibraries.set('B', () => bLibrary.promise);
  act(() => mockRuntime.become('B'));

  // The first frame for B: nothing of A's is rendered or held, anywhere, not
  // even by a component the switch did not re-render.
  expect(text('probe')).not.toContain('A-');
  expect(text('bystander')).toBe('');
  expect(held()).not.toContain('A-');

  // A's late answer lands after the switch: it reaches neither the screen nor
  // B's cache.
  await act(async () => {
    late.resolve(membership('A-private-late'));
    await late.promise;
  });
  expect(text('probe')).not.toContain('A-');
  expect(text('bystander')).toBe('');
  expect(held()).not.toContain('A-');
  expect(queryClient.getQueryData(LIBRARY_QUERY_KEY)).toBeUndefined();

  // B reads its own.
  await act(async () => {
    bLibrary.resolve(membership('B-own'));
    await bLibrary.promise;
  });
  await waitUntil(act, () => text('probe') === 'B-own-track|B-search-result');
  expect(held()).not.toContain('A-');

  // B's blob is B's alone; A's blob (written as A was left) holds A's, and no
  // search result is on disk.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  });
  const bBlob = storage.values.get(accountQueryStorageKey('B'));
  const aBlob = storage.values.get(accountQueryStorageKey('A'));
  expect(bBlob).toContain('B-own-track');
  expect(bBlob).not.toContain('A-');
  expect(bBlob).not.toContain('search-result');
  expect(aBlob).toContain('A-private-track');
  expect(aBlob).not.toContain('late');
  expect(aBlob).not.toContain('search-result');

  // Sign-out: nothing private on screen or in memory, and B's blob is deleted.
  act(() => mockRuntime.become(null));
  expect(text('probe')).not.toContain('B-');
  expect(text('bystander')).toBe('');
  expect(held()).not.toContain('B-');
  await waitUntil(act, () => !storage.values.has(accountQueryStorageKey('B')));

  // A signs in again, offline: its own cached library is back from its own
  // blob, and nothing of B's.
  mockLibraries.set('A', () => new Promise<never>(() => undefined));
  act(() => mockRuntime.become('A'));
  await waitUntil(act, () => text('probe').startsWith('A-private-track'));
  expect(accountQueryCache.isReady()).toBe(true);
  expect(held()).not.toContain('B-');
});
