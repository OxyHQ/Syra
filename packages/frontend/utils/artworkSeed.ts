import type { ArtworkSeeds } from './artworkSeed.types';

/**
 * Native fallback for artwork seed extraction.
 *
 * Reading raw pixels off a rendered image requires a platform-specific bridge
 * (e.g. a native colour-extraction module). Dynamic artwork theming is a web
 * (hover/view) affordance today, so native returns `null` — the app simply keeps
 * its default preset. The `.web.ts` sibling implements the real canvas-based
 * multi-seed extraction.
 */
export async function extractArtworkSeeds(_imageUrl: string): Promise<ArtworkSeeds | null> {
  return null;
}

/** Web canvas support probe — always false on native. */
export function canExtractArtworkSeeds(): boolean {
  return false;
}
