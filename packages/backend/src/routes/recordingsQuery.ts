import { resolvePageLimit } from '@oxy.so/utils/paging';
import type { PublicRecordingSort } from '../db/rooms/recordings';

/** Parse the public recording list's bounded page size and sort order. */
export function parseRecordingListQuery(query: { limit?: unknown; sortBy?: unknown }): {
  sort: PublicRecordingSort;
  limit: number;
} {
  return {
    sort: query.sortBy === 'popular' ? 'popular' : 'recent',
    limit: resolvePageLimit(query.limit, { fallback: 10, max: 50 }),
  };
}
