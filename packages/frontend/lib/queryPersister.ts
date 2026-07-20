import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { QueryClient } from '@tanstack/react-query';
import type { Persister, PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import { createScopedLogger } from '@/utils/logger';

/**
 * Offline-first persistence for the TanStack Query cache, scoped per account.
 *
 * The whole query cache is throttled to AsyncStorage so that a cold start can
 * paint last-known catalog/library/profile data before the network resolves.
 *
 * SCOPING — why the snapshot is keyed per account rather than left to query keys:
 * query keys cannot carry this on their own. `CatalogIdentity` is only
 * `'auth' | 'guest'`, so every signed-in user shares one segment, and keys like
 * `['library']` carry no identity at all. A single unscoped snapshot therefore
 * rehydrates one user's library for whoever signs in next on the same device.
 * Scoping the STORAGE KEY fixes that for every query at once, and cannot be
 * reopened later by one query key that forgets to include an account id.
 *
 * COLD BOOT — the account id is not known when this module is constructed; it
 * arrives later, when the Oxy session resolves. So the last active scope is
 * persisted alongside the snapshot and read back at boot: restore targets the
 * account that was active when the app was last used. When the session then
 * resolves to that same account, {@link applyAccountScope} returns early and the
 * snapshot just hydrated is left untouched. Only a real identity change clears.
 *
 * `buster` is bumped whenever the persisted shape changes so stale snapshots
 * from an older app build are discarded instead of hydrated. `maxAge` caps how
 * long an offline snapshot is trusted before it is thrown away. Only successful
 * queries are dehydrated, so in-flight/errored states never persist.
 */

const persisterLogger = createScopedLogger('QueryPersister');

const PERSIST_BUSTER = 'syra-rq-v1';

/** Scoped snapshot keys: `syra-react-query-cache:guest`, `…:user:<id>`. */
const SCOPED_CACHE_KEY_PREFIX = 'syra-react-query-cache:';
/**
 * The pre-scoping snapshot key. Distinct from {@link SCOPED_CACHE_KEY_PREFIX}
 * (it has no trailing colon), so it is orphaned rather than overwritten by the
 * scoped keys. It holds one account's data, so it is deleted once, on the first
 * boot after this change, closing the leak on devices that already have one.
 */
const LEGACY_UNSCOPED_CACHE_KEY = 'syra-react-query-cache';
/** Remembers which account the snapshot on disk belongs to across cold boots. */
const ACTIVE_SCOPE_STORAGE_KEY = 'syra-react-query-active-scope';

const GUEST_SCOPE = 'guest';

/** Identifies whose snapshot a stored cache belongs to. */
export type AccountScope = string;

export function accountScopeFor(userId: string | null): AccountScope {
  return userId ? `user:${userId}` : GUEST_SCOPE;
}

let activeScope: AccountScope | null = null;
let scopeResolution: Promise<AccountScope> | null = null;
let scopedInnerPersister: { scope: AccountScope; persister: Persister } | null = null;
/**
 * Set only while {@link applyAccountScope} swaps accounts. `queryClient.clear()`
 * notifies the cache subscriber synchronously, and without this the resulting
 * write could land under the wrong account's key.
 */
let isPersistSuspended = false;

/**
 * Resolves once per app run. Reads the scope the last session left behind, so a
 * cold boot restores the right account's snapshot before the session resolves.
 */
function ensureScope(): Promise<AccountScope> {
  if (activeScope !== null) {
    return Promise.resolve(activeScope);
  }
  if (!scopeResolution) {
    scopeResolution = (async () => {
      let resolved = GUEST_SCOPE;
      try {
        await AsyncStorage.removeItem(LEGACY_UNSCOPED_CACHE_KEY);
        resolved = (await AsyncStorage.getItem(ACTIVE_SCOPE_STORAGE_KEY)) ?? GUEST_SCOPE;
      } catch (error) {
        // Falling back to the guest scope is the safe failure: it can cost an
        // offline snapshot, but it can never serve one account's data to another.
        persisterLogger.error('Failed to read the persisted account scope', { error });
      }
      activeScope = resolved;
      return resolved;
    })();
  }
  return scopeResolution;
}

/** One inner persister per scope, kept so its write throttle survives calls. */
function innerPersisterFor(scope: AccountScope): Persister {
  if (scopedInnerPersister?.scope !== scope) {
    scopedInnerPersister = {
      scope,
      persister: createAsyncStoragePersister({
        storage: AsyncStorage,
        key: `${SCOPED_CACHE_KEY_PREFIX}${scope}`,
        throttleTime: 1000,
      }),
    };
  }
  return scopedInnerPersister.persister;
}

const accountScopedPersister: Persister = {
  persistClient: async (client) => {
    if (isPersistSuspended) {
      return;
    }
    // Never overwrite a stored snapshot with an empty one. Without this the
    // `clear()` in `applyAccountScope` would blank the incoming account's saved
    // snapshot before its queries had a chance to refill the cache.
    if (client.clientState.queries.length === 0) {
      return;
    }
    const scope = await ensureScope();
    if (isPersistSuspended) {
      return;
    }
    await innerPersisterFor(scope).persistClient(client);
  },
  restoreClient: async () => {
    const scope = await ensureScope();
    return innerPersisterFor(scope).restoreClient();
  },
  removeClient: async () => {
    const scope = await ensureScope();
    await innerPersisterFor(scope).removeClient();
  },
};

/**
 * Points persistence at `nextScope`, dropping the cache of the account being
 * left — from memory always, and from disk when that account is signing out.
 *
 * Driven by the RESOLVED identity, never by token changes: a token refresh keeps
 * the same account, so it maps to the same scope and returns early instead of
 * clearing the cache.
 */
export async function applyAccountScope(
  nextScope: AccountScope,
  queryClient: QueryClient,
): Promise<void> {
  const currentScope = await ensureScope();
  if (currentScope === nextScope) {
    return;
  }

  isPersistSuspended = true;
  try {
    // Signing out must not leave a readable authenticated snapshot behind.
    // Switching between two signed-in accounts keeps each snapshot under its own
    // key — unreachable from the other account, and still there for offline use.
    if (nextScope === GUEST_SCOPE && currentScope !== GUEST_SCOPE) {
      await innerPersisterFor(currentScope).removeClient();
    }
    // Drops the outgoing account's data from memory, not only from disk.
    queryClient.clear();
    activeScope = nextScope;
    scopeResolution = Promise.resolve(nextScope);
    await AsyncStorage.setItem(ACTIVE_SCOPE_STORAGE_KEY, nextScope);
  } finally {
    isPersistSuspended = false;
  }
}

export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> = {
  persister: accountScopedPersister,
  maxAge: 1000 * 60 * 60 * 24, // 24h — discard offline snapshots older than a day
  buster: PERSIST_BUSTER,
  dehydrateOptions: {
    shouldDehydrateQuery: (query) => query.state.status === 'success',
  },
};
