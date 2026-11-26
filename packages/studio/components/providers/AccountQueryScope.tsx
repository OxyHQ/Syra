import {
  defaultScheduler,
  notifyManager,
  type QueryClient,
  useQueryClient,
} from '@tanstack/react-query';
import { useOxyRuntime } from '@oxy.so/services/runtime';
import { useLayoutEffect } from 'react';

/** The runtime surface the scope follows (`useOxyRuntime()` from `@oxy.so/services/runtime`). */
export interface SubjectSource {
  getSnapshot(): { account: { id?: string | null } | null };
  subscribe(listener: () => void): () => void;
}

/**
 * Drop every query when the session's subject changes (switch, sign-in,
 * sign-out), synchronously, from the Services runtime's own notification, so
 * nothing React renders for the new account can read the previous one's.
 *
 * Every Studio read is the signed-in creator's. A removed query is also reset:
 * a screen still subscribed to it shows nothing of the account that was left,
 * and its in-flight read is cancelled, so a late answer lands nowhere. Studio
 * keeps its queries in memory only (Services 14 also persisted them per
 * account; Services 15 holds no React Query cache).
 */
export function followAccount(queryClient: QueryClient, runtime: SubjectSource): () => void {
  // Unknown at first: whatever a render made before this ran is dropped too.
  let accountId: string | null | undefined;
  const sync = () => {
    const next = runtime.getSnapshot().account?.id ?? null;
    if (next === accountId) return;
    accountId = next;
    // Synchronous notifications (React Query's default is a `setTimeout`): the
    // screens re-render in the same pass as the new account. Studio sets no
    // scheduler of its own, so the default comes back.
    const cache = queryClient.getQueryCache();
    notifyManager.setScheduler((callback) => callback());
    try {
      notifyManager.batch(() => {
        for (const query of cache.getAll()) {
          cache.remove(query);
          query.reset();
        }
      });
    } finally {
      notifyManager.setScheduler(defaultScheduler);
    }
  };
  const unsubscribe = runtime.subscribe(sync);
  sync();
  return unsubscribe;
}

/** Mounted once, as the first child of `OxyProvider`; renders nothing. */
export function AccountQueryScope(): null {
  const queryClient = useQueryClient();
  const runtime = useOxyRuntime();
  useLayoutEffect(() => followAccount(queryClient, runtime), [queryClient, runtime]);
  return null;
}
