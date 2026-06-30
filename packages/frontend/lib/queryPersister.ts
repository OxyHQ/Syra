import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client';

/**
 * Offline-first persistence for the TanStack Query cache.
 *
 * The whole query cache is throttled to AsyncStorage so that a cold start can
 * paint last-known catalog/library/profile data before the network resolves.
 *
 * `buster` is bumped whenever the persisted shape changes so stale snapshots
 * from an older app build are discarded instead of hydrated. `maxAge` caps how
 * long an offline snapshot is trusted before it is thrown away.
 *
 * Guest vs. authenticated separation is preserved by the query keys themselves
 * (see AGENTS.md): persisting does not merge a guest snapshot into an
 * authenticated key because the keys differ. Only successful queries are
 * dehydrated, so in-flight/errored states never persist.
 */
const PERSIST_BUSTER = 'syra-rq-v1';

const asyncStoragePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'syra-react-query-cache',
  throttleTime: 1000,
});

export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> = {
  persister: asyncStoragePersister,
  maxAge: 1000 * 60 * 60 * 24, // 24h — discard offline snapshots older than a day
  buster: PERSIST_BUSTER,
  dehydrateOptions: {
    shouldDehydrateQuery: (query) => query.state.status === 'success',
  },
};
