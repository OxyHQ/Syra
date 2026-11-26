import { QueryClient } from '@tanstack/react-query';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';
import { createAccountQueryCache } from '@/lib/accountQueryCache';

/**
 * Syra's React Query client. Services 15 holds no React Query cache, so
 * `AppProviders` mounts this one in a `QueryClientProvider` above `OxyProvider`.
 */
export const queryClient = new QueryClient(QUERY_CLIENT_CONFIG);

/**
 * Every Syra read may depend on who is signed in (the catalog answers `auth`
 * and `guest` differently; library, playlists and history are the account's),
 * so all of them are the account's: persisted per account, discarded on every
 * new build, dropped from memory on an account switch and deleted on sign-out.
 * Search results are never written to disk (`lib/accountQueryCache.ts`;
 * `AccountQueryScope` drives it from the Services runtime).
 */
export const accountQueryCache = createAccountQueryCache(queryClient);
