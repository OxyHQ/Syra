/**
 * Provider-related constants
 * Optimized for performance and better caching
 * Big tech best practices for React Query configuration
 */

import { QueryCache, type QueryClientConfig } from '@tanstack/react-query';
import { toast } from '@/lib/sonner';
import { getErrorStatus } from '@/utils/api';

// A single toast id collapses a burst of simultaneous failures (e.g. a screen
// firing several queries against a down backend) into one visible message.
const QUERY_ERROR_TOAST_ID = 'query-error';

export const QUERY_CLIENT_CONFIG: QueryClientConfig = {
  defaultOptions: {
    queries: {
      // Retry strategy - exponential backoff
      retry: (failureCount: number, error: unknown) => {
        // Don't retry on 4xx errors (client errors)
        const status = getErrorStatus(error);
        if (status !== undefined && status >= 400 && status < 500) {
          return false;
        }
        // Retry up to 2 times for network/server errors
        return failureCount < 2;
      },
      retryDelay: (attemptIndex: number) => Math.min(1000 * 2 ** attemptIndex, 30000),

      // Cache configuration - aggressive caching for better performance
      staleTime: 1000 * 60 * 5, // 5 minutes - data stays fresh
      gcTime: 1000 * 60 * 30, // 30 minutes - cache persists for 30 min

      // Refetch strategy - minimize unnecessary network requests
      refetchOnReconnect: true, // Refetch when connection restored
      // Disabled - refetching everything on every return to the app is noise.
      // NOTE: this does NOT make the `focusManager` wiring in app/_layout.tsx
      // redundant. That wiring is what pauses `refetchInterval` while the app is
      // backgrounded (query-core checks `focusManager.isFocused()` unless
      // `refetchIntervalInBackground` is set), which the polling search queries
      // in TopBar.tsx and app/search.tsx rely on. Removing it as dead code would
      // leave them polling forever in the background on native.
      refetchOnWindowFocus: false,
      // `true`, not `'always'`: refetch on mount only once a query's own
      // staleTime has elapsed. Every query here declares a deliberate staleTime
      // (30s for continue-listening through 1h for podcast metadata); with this
      // set to `false` none of them could ever drive a refetch on mount, leaving
      // reconnect as the app's only automatic refresh and letting a screen paint
      // day-old persisted data indefinitely. Cached data still renders instantly
      // — a refetch over existing data is a background one, so this never turns
      // a populated screen back into a skeleton.
      refetchOnMount: true,

      // Enable structural sharing for better performance
      // Compares data structures to minimize re-renders
      structuralSharing: true,

      // Network mode - handle offline gracefully
      networkMode: 'online', // Only refetch when online
    },
    mutations: {
      // Mutation retry - only once for failed mutations
      retry: 1,
      retryDelay: 1000,

      // Optimistic updates enabled by default (implement per mutation)
      // This provides instant UI feedback
    },
  },

  // Global fallback for query failures, so a rejected fetch is never silent.
  // Mutations are deliberately NOT handled here: the mutations that need user
  // feedback already report it from their own `onError` (where they also roll
  // back their optimistic update), and a MutationCache handler would surface a
  // second toast for the same failure.
  queryCache: new QueryCache({
    onError: (error, query) => {
      // Only surface a failure the user would otherwise see as an empty screen.
      // A background refetch that still has cached data to fall back on stays
      // silent — the UI keeps showing valid data, so a toast would be noise.
      if (query.state.data !== undefined) {
        return;
      }
      toast.error(error.message || 'Something went wrong. Please try again.', {
        id: QUERY_ERROR_TOAST_ID,
      });
    },
  }),
};
