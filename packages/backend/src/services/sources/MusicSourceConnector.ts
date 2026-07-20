import type { CatalogSource, ExternalTrack } from '@syra/shared-types';

/** Injectable HTTP GET abstraction — accepts a URL, returns parsed JSON as unknown. */
export type HttpGetJson = (url: string) => Promise<unknown>;

/**
 * Common interface for all external music catalog connectors.
 *
 * Each connector is responsible for:
 *  - Querying a single external provider (CC/Jamendo, etc.)
 *  - Normalising results to `ExternalTrack` before returning them
 *  - Filtering out tracks that Syra cannot legally host (e.g. NC licenses for CC)
 *
 * Connectors must NOT mutate the catalog directly — callers pass results to
 * the import service (Phase 7.4) which handles deduplication and persistence.
 */
export interface MusicSourceConnector {
  /** The catalog source this connector targets. */
  readonly provider: CatalogSource;

  /**
   * Search the external catalog for tracks matching `query`.
   *
   * @param query  Free-text search string
   * @param limit  Maximum number of results (provider default if omitted)
   * @returns      Normalised external tracks, license-filtered where applicable
   */
  search(query: string, limit?: number): Promise<ExternalTrack[]>;
}

export type { ExternalTrack };
