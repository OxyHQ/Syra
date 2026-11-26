import type { Query, QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { StorageInterface, SubjectSource } from '@/lib/accountQueryCache';

/** A Map-backed `StorageInterface` whose contents a test can inspect. */
export function memoryStorage(
  initial: Record<string, string> = {},
): StorageInterface & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

export type FakeRuntime = SubjectSource & {
  /** The account whose bearer a request made now would carry. */
  current: () => string | null;
  become: (id: string | null) => void;
};

/**
 * The session as Services' runtime publishes it: `become` commits the new
 * subject to the snapshot, then wakes every subscriber in one synchronous pass
 * (`createOxyRuntime`'s `transition` then `notify`).
 */
export function createRuntime(initial: string | null): FakeRuntime {
  let snapshot: { account: { id: string } | null } = { account: initial ? { id: initial } : null };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    current: () => snapshot.account?.id ?? null,
    become: (id) => {
      snapshot = { account: id ? { id } : null };
      for (const listener of [...listeners]) listener();
    },
  };
}

/** `useOxy()` as Services derives it from the runtime: re-rendered on its notification. */
export function useFakeOxy(runtime: FakeRuntime) {
  const { account } = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  return {
    user: account,
    isAuthenticated: account !== null,
    canUsePrivateApi: account !== null,
    isPrivateApiPending: false,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A library membership whose liked track ids carry `marker`. */
export function membership(marker: string) {
  return {
    likedTracks: [`${marker}-track`],
    savedAlbums: [],
    followedArtists: [],
    savedPlaylists: [],
    subscribedPodcasts: [],
  };
}

/** Let React and pending promises settle, `ms` of real time at a time, until `check` holds. */
export async function waitUntil(
  act: (callback: () => Promise<void>) => Promise<unknown>,
  check: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

/**
 * Every query `queryClient` creates from now on. A query the cache removed
 * while a screen still watched it schedules its garbage collection (30
 * minutes) when that screen unmounts, out of the client's reach, and the
 * timer keeps Jest alive: `destroy()` cancels it.
 */
export function trackQueries(queryClient: QueryClient): { destroyAll: () => void } {
  const created = new Set<Query>();
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'added') created.add(event.query);
  });
  return {
    destroyAll: () => {
      for (const query of created) query.destroy();
      created.clear();
    },
  };
}
