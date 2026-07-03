import { QueryClient } from '@tanstack/react-query';

/**
 * React Query client for Syra Studio. Server state (shows, episodes) is
 * owned here; mutations invalidate the relevant keys so the UI updates without a
 * reload.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Don't retry client (4xx) errors; retry network/server errors twice.
      retry: (failureCount: number, error: unknown) => {
        const status = (error as { status?: number } | null)?.status;
        if (status !== undefined && status >= 400 && status < 500) {
          return false;
        }
        return failureCount < 2;
      },
      retryDelay: (attemptIndex: number) => Math.min(1000 * 2 ** attemptIndex, 30000),
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 30,
      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      structuralSharing: true,
      networkMode: 'online',
    },
    mutations: {
      retry: 1,
      retryDelay: 1000,
    },
  },
});
