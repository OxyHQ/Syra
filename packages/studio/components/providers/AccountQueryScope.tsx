import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
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
    const cache = queryClient.getQueryCache();
    for (const query of cache.getAll()) {
      cache.remove(query);
      query.reset();
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
