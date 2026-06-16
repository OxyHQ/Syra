import { useQuery } from '@tanstack/react-query';
import type { Lyrics } from '@syra/shared-types';
import { api, isNotFoundError } from '@/utils/api';

/** Lyrics are fetched once and treated as immutable — 24h stale time. */
const LYRICS_STALE_TIME_MS = 1000 * 60 * 60 * 24;

/**
 * Fetch synced or plain lyrics for a track.
 *
 * - `enabled` is false when `trackId` is undefined — no request fires.
 * - A 404 response is treated as "no lyrics available" and returns `null`
 *   rather than surfacing an error. All other failures set `isError`.
 *
 * @param trackId  Catalog track ObjectId; omit to disable the query.
 */
export function useLyrics(trackId?: string): {
  lyrics: Lyrics | null;
  isLoading: boolean;
  isError: boolean;
} {
  const { data, isLoading, isError } = useQuery<Lyrics | null>({
    queryKey: ['lyrics', trackId],
    queryFn: async () => {
      try {
        const res = await api.get<Lyrics>(`/lyrics/${trackId}`);
        return res.data;
      } catch (err) {
        if (isNotFoundError(err)) return null;
        throw err;
      }
    },
    enabled: !!trackId,
    staleTime: LYRICS_STALE_TIME_MS,
  });

  return {
    lyrics: data ?? null,
    isLoading,
    isError,
  };
}
