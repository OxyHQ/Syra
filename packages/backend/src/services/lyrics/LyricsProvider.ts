import type { Lyrics, LyricsQuery } from '@syra/shared-types';

/**
 * Common interface for all lyrics providers.
 *
 * Concrete implementations (LrclibProvider, future licensed sources) return
 * lyrics without `trackId` or `updatedAt` — those are added by the cache
 * layer when persisting to MongoDB.
 */
export interface LyricsProvider {
  /** Identifier for the upstream source (e.g. 'lrclib'). */
  readonly source: string;

  /**
   * Fetch lyrics for a track from the upstream provider.
   *
   * @returns Lyrics payload (without `trackId`/`updatedAt`) or null when the
   *          provider has no lyrics for the requested track.
   */
  getLyrics(query: LyricsQuery): Promise<Omit<Lyrics, 'trackId' | 'updatedAt'> | null>;
}
