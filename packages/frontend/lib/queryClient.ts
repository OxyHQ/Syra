import { QueryClient } from '@tanstack/react-query';
import type { AccountQueriesConfig } from '@oxy.so/services';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';

export const queryClient = new QueryClient(QUERY_CLIENT_CONFIG);

/**
 * Every Syra read may depend on who is signed in (the catalog answers `auth`
 * and `guest` differently; library, playlists and history are the account's),
 * so all of them are the account's: `OxyProvider` persists them per account,
 * discards them on every new build, drops them from memory on an account switch
 * and deletes them on sign-out. Search results are never written to disk.
 */
export const SYRA_ACCOUNT_QUERIES: AccountQueriesConfig = {
  roots: 'all',
  memoryOnlyRoots: ['search'],
};
