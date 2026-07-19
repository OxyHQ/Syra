/**
 * Native fallback for artwork seed extraction.
 *
 * Reading raw pixels off a rendered image requires a platform-specific bridge
 * (e.g. a native colour-extraction module). Dynamic artwork theming is a web
 * (hover/focus) affordance today, so native returns `null` — the ambient region
 * simply keeps the app preset. The `.web.ts` sibling implements the real
 * canvas-based extraction.
 */
export async function extractArtworkSeed(_imageUrl: string): Promise<string | null> {
  return null;
}

/** Web canvas support probe — always false on native. */
export function canExtractArtworkSeed(): boolean {
  return false;
}
