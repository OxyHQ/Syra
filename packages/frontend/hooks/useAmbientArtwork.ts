import { useCallback, useEffect, useRef } from 'react';

import { useAmbientThemeStore } from '@/stores/ambientTheme';
import { extractArtworkSeeds } from '@/utils/artworkSeed';
import type { ArtworkSeeds } from '@/utils/artworkSeed.types';

/**
 * Process-wide cache of extracted seed trios, keyed by a stable artwork id.
 * Extraction is deterministic for a given image, so a trio is computed at most
 * once per artwork and reused across every card/hero that shows it.
 *
 * IMPORTANT (React Compiler): this module-level mutable Map is ONLY ever touched
 * inside event handlers / effects — never read from a render or memoized
 * position. The rendered ambient value lives in the Zustand store (subscribed to
 * by the root provider), so the compiler never freezes a stale read of this
 * external cache.
 */
const seedCache = new Map<string, ArtworkSeeds | null>();

const DEFAULT_DEBOUNCE_MS = 120;

interface AmbientDriver {
  /**
   * Begin (debounced) extraction for the given artwork and, once ready, theme
   * the whole app from it. If the id is cached, the theme applies immediately
   * with no recompute. Call on hover-in / view.
   */
  apply: (artworkId: string | undefined, imageUrl: string | undefined) => void;
  /** Restore the app's default preset theme. Call on hover-out / leave. */
  clear: () => void;
}

/**
 * Shared ambient-artwork driver. Owns the ONE debounced, per-artwork-id-cached,
 * last-intent-wins extraction pipeline and writes the result into the app-wide
 * ambient-theme store. Both `useHoverAmbient` and `useViewAmbient` build on this
 * — the extraction logic lives here exactly once, never duplicated.
 *
 * React-Compiler-safe: the store's mutable state is only ever written from the
 * handlers/effect below (never read/written in a render or memo position), and
 * the `seedCache`/timer refs are handler-and-effect-only too.
 */
function useAmbientDriver(debounceMs = DEFAULT_DEBOUNCE_MS): AmbientDriver {
  const setAmbient = useAmbientThemeStore((s) => s.setAmbient);
  const clearAmbient = useAmbientThemeStore((s) => s.clearAmbient);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic token so a slow extraction that resolves after a newer
  // apply/clear is ignored (last-intent-wins).
  const requestRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const apply = useCallback(
    (artworkId: string | undefined, imageUrl: string | undefined) => {
      clearTimer();
      const requestId = ++requestRef.current;

      if (!artworkId || !imageUrl) return;

      const cached = seedCache.get(artworkId);
      if (cached !== undefined) {
        // `null` cached means "extraction known to be impossible" — keep preset.
        if (cached) setAmbient(cached);
        else clearAmbient();
        return;
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void extractArtworkSeeds(imageUrl).then((extracted) => {
          seedCache.set(artworkId, extracted);
          // Ignore if a newer apply/clear has since superseded this one.
          if (requestRef.current !== requestId) return;
          if (extracted) setAmbient(extracted);
          else clearAmbient();
        });
      }, debounceMs);
    },
    [clearTimer, debounceMs, setAmbient, clearAmbient],
  );

  const clear = useCallback(() => {
    clearTimer();
    requestRef.current++;
    clearAmbient();
  }, [clearTimer, clearAmbient]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return { apply, clear };
}

export interface HoverAmbient {
  /** Theme the whole app from a hovered card's artwork. Call on hover-in. */
  onHoverIn: (card: { id: string; imageUrl: string | undefined }) => void;
  /** Restore the app's default theme. Call on hover-out. */
  onHoverOut: () => void;
}

/**
 * HOVER MODE (home / browse-grid screens). Wire the returned handlers to
 * `MediaCard`'s `onHoverIn({ id, imageUrl })` / `onHoverOut` (+ `seedId`):
 * hovering a card themes the ENTIRE app from that card's artwork; leaving
 * restores the default. No-op cleanly on native (extraction returns null).
 */
export function useHoverAmbient(): HoverAmbient {
  const { apply, clear } = useAmbientDriver();

  const onHoverIn = useCallback(
    (card: { id: string; imageUrl: string | undefined }) => {
      apply(card.id, card.imageUrl);
    },
    [apply],
  );

  return { onHoverIn, onHoverOut: clear };
}

/**
 * VIEW MODE (detail pages: album / artist / playlist / podcast show / episode).
 * Themes the whole app from the page's main cover ON VIEW (mount) and restores
 * the default on leave (unmount). It does NOT theme on hover — the page stays
 * themed the whole time you're on it.
 *
 * The mount/unmount lifecycle IS the view lifecycle here: the root layout renders
 * a single route via `<Slot />`, so a detail screen unmounts when the user
 * navigates away, which fires the cleanup and restores the default theme. Re-runs
 * whenever the cover id/url changes (e.g. data loads in after the first paint).
 */
export function useViewAmbient(
  artworkId: string | undefined,
  imageUrl: string | undefined,
): void {
  const { apply, clear } = useAmbientDriver();

  useEffect(() => {
    apply(artworkId, imageUrl);
    return () => clear();
  }, [apply, clear, artworkId, imageUrl]);
}
