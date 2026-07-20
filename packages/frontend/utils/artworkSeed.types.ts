/**
 * Platform-agnostic types for artwork seed extraction.
 *
 * Kept in a bare (non-`.web`/`.native`) module so both the web and native
 * implementations of `extractArtworkSeeds`, the ambient-theme store, and the
 * shared driver hook can import the same shape without pulling in any
 * platform-specific code (canvas / DOM on web, nothing on native).
 */

/**
 * The colours extracted from a single piece of artwork, used to theme the whole
 * app dynamically.
 *
 * - `seed` — the dominant colour (`#rrggbb`); drives the app-wide theme.
 * - `secondarySeed` / `tertiarySeed` — the 2nd/3rd most representative colours,
 *   pinned as the seed's secondary/tertiary accents. Absent when the artwork has
 *   fewer than 3 distinct suitable colours.
 */
export interface ArtworkSeeds {
  seed: string;
  secondarySeed?: string;
  tertiarySeed?: string;
}
