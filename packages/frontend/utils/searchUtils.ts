import type { SearchResult } from '@syra/shared-types';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Extends the canonical `SearchResult` with the `pendingAudiusImport` flag
 * added by the backend (Task 9.4) when a background Audius import was kicked
 * off and local track results were sparse.
 */
export interface SearchResultWithPending extends SearchResult {
  /** True when the server fired a background Audius import for this query. */
  pendingAudiusImport?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Polling interval (ms) while a background Audius import is in flight.
 * The query re-fetches at this cadence until the import lands and the server
 * returns `pendingAudiusImport: false` (or tracks appear locally).
 */
export const AUDIUS_REFETCH_MS = 8000;

// ── Pure predicate ────────────────────────────────────────────────────────────

/**
 * Determines whether the search query should keep polling and at what interval.
 *
 * Returns `AUDIUS_REFETCH_MS` when:
 *  - The server flagged a pending Audius import (`pendingAudiusImport: true`),
 *    AND the local track results are still empty (once tracks appear, the import
 *    has landed — no further polls needed).
 *
 * Returns `false` (stop / never poll) otherwise.
 *
 * Pass this as `refetchInterval` in the `useQuery` options.
 */
export function searchRefetchInterval(
  data: SearchResultWithPending | null | undefined,
): number | false {
  if (!data) return false;
  if (!data.pendingAudiusImport) return false;
  // Import has landed once tracks appear in local results
  if ((data.results.tracks?.length ?? 0) > 0) return false;
  return AUDIUS_REFETCH_MS;
}
