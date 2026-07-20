import type { SearchResult } from '@syra/shared-types';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Extends the canonical `SearchResult` with the background-import flag the
 * backend adds when it kicks off a podcast directory import for a query whose
 * local results were sparse.
 */
export interface SearchResultWithPending extends SearchResult {
  /** True when the server fired a background podcast directory import for this query. */
  pendingPodcastImport?: boolean;
}
