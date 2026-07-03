import { useQuery } from '@tanstack/react-query';
import type { User } from '@oxyhq/core';
import { oxyServices } from '@/lib/oxyServices';

const MIN_QUERY_LENGTH = 2;

/**
 * Searches Oxy users for the Hosts/Guests picker. Backed by the SDK's
 * `searchProfiles` (returns `{ data: User[], pagination }`); the picker only
 * ever stores real Oxy user ids, so there is no free-text path.
 */
export function useUserSearch(query: string) {
  const trimmed = query.trim();
  return useQuery<User[]>({
    queryKey: ['studio', 'user-search', trimmed],
    queryFn: async () => {
      const response = await oxyServices.searchProfiles(trimmed, { limit: 10 });
      return response.data;
    },
    enabled: trimmed.length >= MIN_QUERY_LENGTH,
    staleTime: 1000 * 60,
  });
}
