/**
 * Syra's per-account query cache.
 *
 * Services 14 ran this for Syra (`OxyProvider accountQueries`, roots `'all'`).
 * Services 15 keeps its own data in one `@oxy.so/bloom-data` store per account
 * and holds no React Query cache, so Syra owns its own, with the same rules:
 *
 * - Every query is the signed-in account's: the catalog answers `auth` and
 *   `guest` differently, and library, playlists and history are the account's.
 *   On every subject change (switch, sign-in, sign-out) all of them are
 *   removed from memory synchronously, from the Services runtime's own
 *   notification (`followOxyRuntime`), before React renders the new account.
 *   A removed query is also reset, so a screen still subscribed to it shows
 *   nothing of the account that was left, and its in-flight read is cancelled:
 *   a late answer lands in a query nobody can reach.
 * - Each account's successful queries are written to its own key
 *   (`syra_account_queries:<accountId>`; localStorage on the web, AsyncStorage
 *   on a device), so a restore can only hydrate the account that is signed in.
 *   `search` is memory only. Signed out, nothing is written.
 * - A blob written by another build is not restored (its buster is the build,
 *   `OXY_BUILD_ID`), and one older than seven days is deleted.
 * - Leaving an account writes its latest state first; a sign-out then deletes
 *   it. Every storage operation runs through one queue, in order, and a
 *   restore checks that its account is still the active one in the same tick
 *   it hydrates.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  type DehydratedState,
  dehydrate,
  hydrate,
  type Query,
  type QueryClient,
} from '@tanstack/react-query';
import { Platform } from 'react-native';

/** The key-value storage the cache writes its blobs to (AsyncStorage, localStorage). */
export interface StorageInterface {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** The runtime surface the cache follows (`useOxyRuntime()` from `@oxy.so/services/runtime`). */
export interface SubjectSource {
  getSnapshot(): { account: { id?: string | null } | null };
  subscribe(listener: () => void): () => void;
}

/** Roots that belong to the account but never reach the disk. */
export const MEMORY_ONLY_QUERY_ROOTS: readonly string[] = ['search'];

/**
 * The storage key prefix. Not Services 14's `oxy_account_queries` (Services 15
 * deletes every key under it once), nor `syra-react-query-`
 * (`utils/removeLegacyQueryCache.ts` deletes those), and without "cache" in it,
 * which Settings' "Clear cache" matches.
 */
export const ACCOUNT_QUERY_STORAGE_PREFIX = 'syra_account_queries';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PERSIST_THROTTLE_MS = 1_000;

export function accountQueryStorageKey(accountId: string): string {
  return `${ACCOUNT_QUERY_STORAGE_PREFIX}:${encodeURIComponent(accountId)}`;
}

/**
 * The identity of the running JS bundle, the buster of every blob.
 * `@oxy.so/app-preset`'s production Babel config inlines `OXY_BUILD_ID` (the
 * commit); a development or test build gets a constant.
 */
export function getBuildId(): string {
  const buildId = typeof process === 'undefined' ? undefined : process.env.OXY_BUILD_ID;
  return buildId || 'unversioned';
}

interface PersistedBlob {
  buster: string;
  timestamp: number;
  clientState: DehydratedState;
}

function persistsQuery(query: Pick<Query, 'queryKey'>): boolean {
  const root = query.queryKey[0];
  return typeof root !== 'string' || !MEMORY_ONLY_QUERY_ROOTS.includes(root);
}

/** Serialize the client's persistable, successful queries, stamped with `buster`. */
export function snapshot(queryClient: QueryClient, buster: string = getBuildId()): string {
  const blob: PersistedBlob = {
    buster,
    timestamp: Date.now(),
    clientState: dehydrate(queryClient, {
      shouldDehydrateQuery: (query) => query.state.status === 'success' && persistsQuery(query),
      shouldDehydrateMutation: () => false,
    }),
  };
  return JSON.stringify(blob);
}

/**
 * Hydrate a stored blob, synchronously, so the caller can check it is still
 * wanted immediately before. False when it is unusable (unreadable, expired):
 * the caller deletes it. A blob from another build is usable but restores
 * nothing (the next write replaces it).
 */
function hydrateBlob(queryClient: QueryClient, raw: string, buster: string): boolean {
  let blob: PersistedBlob;
  try {
    blob = JSON.parse(raw) as PersistedBlob;
  } catch {
    return false;
  }
  if (
    !blob?.clientState ||
    typeof blob.timestamp !== 'number' ||
    Date.now() - blob.timestamp > MAX_AGE_MS
  ) {
    return false;
  }
  if (blob.buster !== buster) return true;
  hydrate(queryClient, {
    queries: (blob.clientState.queries ?? []).filter(persistsQuery),
    mutations: [],
  });
  return true;
}

export interface AccountQueryCache {
  /** Storage became available. Only the first call counts. */
  setStorage(storage: StorageInterface): void;
  /** The session's subject changed (`null`: signed out). Synchronous in-memory reset. */
  activate(accountId: string | null): void;
  /** Start restoring and writing the active account. */
  attach(): void;
  /** Stop touching the client and storage, after writing the active account once more. */
  detach(): void;
  /** Whether the active account's blob has been restored (always true signed out). */
  isReady(): boolean;
}

export function createAccountQueryCache(
  queryClient: QueryClient,
  buster: string = getBuildId(),
): AccountQueryCache {
  let resolveStorage: (storage: StorageInterface) => void = () => undefined;
  const storageReady = new Promise<StorageInterface>((resolve) => {
    resolveStorage = resolve;
  });
  let hasStorage = false;
  // Every read, write and delete runs here, in order, once storage exists.
  let io: Promise<unknown> = storageReady;
  const enqueue = (operation: (storage: StorageInterface) => Promise<unknown> | unknown) => {
    io = io
      .then(() => storageReady)
      .then(operation)
      .catch(() => undefined);
  };

  let attached = false;
  let accountId: string | null = null;
  let restoredFor: string | null = null;
  // Bumped on every subject change and detach: work started for an older one is dropped.
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopWriting: (() => void) | null = null;

  const write = (id: string) => {
    const serialized = snapshot(queryClient, buster);
    const key = accountQueryStorageKey(id);
    enqueue((storage) => storage.setItem(key, serialized));
  };

  const dropAccountQueries = () => {
    const cache = queryClient.getQueryCache();
    for (const query of cache.getAll()) {
      cache.remove(query);
      // A removed query keeps its data and its observers until they render
      // again; resetting it tells them now, and cancels its in-flight read.
      query.reset();
    }
  };

  const startWriting = (id: string, current: number) => {
    const flush = () => {
      timer = null;
      if (current === generation) write(id);
    };
    const off = queryClient.getQueryCache().subscribe((event) => {
      if (timer === null && persistsQuery(event.query))
        timer = setTimeout(flush, PERSIST_THROTTLE_MS);
    });
    stopWriting = () => {
      off();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      stopWriting = null;
    };
  };

  const restore = () => {
    const id = accountId;
    if (!attached || id === null) return;
    const current = generation;
    const key = accountQueryStorageKey(id);
    enqueue(async (storage) => {
      // An unreadable blob restores nothing; it must not leave the account unready.
      const raw = await storage.getItem(key).catch(() => null);
      // Same tick as the hydrate: a switch in between cannot be missed.
      if (current !== generation) return;
      if (raw !== null && !hydrateBlob(queryClient, raw, buster)) {
        await storage.removeItem(key).catch(() => undefined);
        if (current !== generation) return;
      }
      restoredFor = id;
      startWriting(id, current);
    });
  };

  return {
    setStorage(next) {
      if (hasStorage) return;
      hasStorage = true;
      resolveStorage(next);
    },

    activate(next) {
      if (next === accountId) return;
      const previous = accountId;
      // Keep the leaving account's latest state, but only once its own blob
      // was restored: before that, nothing in memory is known to be its own.
      if (previous !== null && restoredFor === previous) write(previous);
      generation += 1;
      stopWriting?.();
      dropAccountQueries();
      accountId = next;
      restoredFor = null;
      if (next === null && previous !== null) {
        const key = accountQueryStorageKey(previous);
        enqueue((storage) => storage.removeItem(key));
      }
      restore();
    },

    attach() {
      if (attached) return;
      attached = true;
      restore();
    },

    detach() {
      if (!attached) return;
      if (accountId !== null && restoredFor === accountId) write(accountId);
      attached = false;
      generation += 1;
      stopWriting?.();
      restoredFor = null;
    },

    isReady: () => accountId === null || restoredFor === accountId,
  };
}

/** In-memory storage: a device or tab with none still gets a working, unpersisted cache. */
export function createMemoryStorage(): StorageInterface {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

/** localStorage on the web, AsyncStorage on a device: where Services 14 kept these blobs. */
export function createPlatformStorage(): StorageInterface {
  if (Platform.OS === 'web') {
    // A browser that blocks site storage throws on the property itself: keep
    // the cache in memory for this page rather than failing the whole tree.
    let local: Storage | undefined;
    try {
      local = typeof window === 'undefined' ? undefined : window.localStorage;
    } catch {
      return createMemoryStorage();
    }
    if (!local) return createMemoryStorage();
    return {
      getItem: async (key) => local.getItem(key),
      setItem: async (key, value) => local.setItem(key, value),
      removeItem: async (key) => local.removeItem(key),
    };
  }
  return {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key),
  };
}

/**
 * Keep `cache` on the runtime's subject: activated now, and again from the
 * runtime's notification on every change, synchronously, before any component
 * woken by it renders. Returns the disposer.
 */
export function followOxyRuntime(
  cache: AccountQueryCache,
  runtime: SubjectSource,
  storage: StorageInterface = createPlatformStorage(),
): () => void {
  cache.setStorage(storage);
  const sync = () => cache.activate(runtime.getSnapshot().account?.id ?? null);
  const unsubscribe = runtime.subscribe(sync);
  sync();
  cache.attach();
  return () => {
    unsubscribe();
    cache.detach();
  };
}
