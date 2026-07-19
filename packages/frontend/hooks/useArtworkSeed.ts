import { useCallback, useEffect, useRef, useState } from 'react';

import { extractArtworkSeed } from '../utils/artworkSeed';

/**
 * Process-wide cache of extracted seeds, keyed by a stable artwork id. Extraction
 * is deterministic for a given image, so a seed is computed at most once per
 * artwork and reused across every card/hero that shows it.
 *
 * IMPORTANT (React Compiler): this module-level mutable Map is ONLY ever touched
 * inside event handlers / effects — never read from a render or memoized
 * position. The rendered value lives in `useState` (`seed`) below, so the
 * compiler never freezes a stale read of this external store.
 */
const seedCache = new Map<string, string | null>();

const DEFAULT_DEBOUNCE_MS = 120;

interface UseArtworkSeedOptions {
  /** Debounce before extraction kicks off, in ms. Defaults to 120. */
  debounceMs?: number;
}

interface UseArtworkSeedResult {
  /** The extracted seed (`#rrggbb`), or `null` when none is active/available. */
  seed: string | null;
  /**
   * Begin (debounced) extraction for the given artwork. Call on hover-in/focus.
   * If the id is cached, the seed applies immediately with no recompute.
   */
  activate: (artworkId: string | undefined, imageUrl: string | undefined) => void;
  /** Clear the active seed (restore the app preset). Call on hover-out/blur. */
  deactivate: () => void;
}

/**
 * Manage the seed colour extracted from a piece of artwork for dynamic ambient
 * theming. Debounces hover so a quick pass over a card never triggers work,
 * caches per artwork id, and cancels cleanly on unmount.
 */
export function useArtworkSeed(options?: UseArtworkSeedOptions): UseArtworkSeedResult {
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const [seed, setSeed] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic token so a slow extraction that resolves after a newer
  // activate/deactivate is ignored (last-intent-wins).
  const requestRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const activate = useCallback(
    (artworkId: string | undefined, imageUrl: string | undefined) => {
      clearTimer();
      const requestId = ++requestRef.current;

      if (!artworkId || !imageUrl) return;

      const cached = seedCache.get(artworkId);
      if (cached !== undefined) {
        // `null` cached means "extraction known to be impossible" — keep preset.
        setSeed(cached);
        return;
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void extractArtworkSeed(imageUrl).then((extracted) => {
          seedCache.set(artworkId, extracted);
          // Ignore if a newer activate/deactivate has since superseded this one.
          if (requestRef.current === requestId) setSeed(extracted);
        });
      }, debounceMs);
    },
    [clearTimer, debounceMs],
  );

  const deactivate = useCallback(() => {
    clearTimer();
    requestRef.current++;
    setSeed(null);
  }, [clearTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return { seed, activate, deactivate };
}
