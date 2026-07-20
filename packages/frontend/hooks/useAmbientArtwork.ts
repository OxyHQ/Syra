import { useCallback, useEffect, useRef } from 'react';

import { useAmbientThemeStore } from '@/stores/ambientTheme';

const DEFAULT_DEBOUNCE_MS = 120;

/** The already-known cover colours for an item (server-extracted DTO fields). */
export interface AmbientColors {
  /** Dominant cover colour (`#rrggbb`); themes the whole app when present. */
  primaryColor?: string;
  /** Supporting cover colour (`#rrggbb`), pinned as the secondary accent. */
  secondaryColor?: string;
}

interface AmbientDriver {
  /**
   * Theme the whole app from an item's already-known cover colours. Debounced so
   * a fast pointer pass doesn't thrash; last-intent-wins. When `primaryColor` is
   * absent the ambient is cleared (the default preset stays). Call on
   * hover-in / view.
   */
  apply: (colors: AmbientColors) => void;
  /** Restore the app's default preset theme. Call on hover-out / leave. */
  clear: () => void;
}

/**
 * Shared ambient-artwork driver. Owns the ONE debounced, last-intent-wins
 * pipeline that writes an item's cover colours into the app-wide ambient-theme
 * store. Both `useHoverAmbient` and `useViewAmbient` build on this — the logic
 * lives here exactly once, never duplicated.
 *
 * The seed source is the catalog's SERVER-EXTRACTED cover colours
 * (`primaryColor` / `secondaryColor`), already carried on every catalog DTO — so
 * applying a theme is synchronous (no canvas extraction, no image re-fetch, no
 * CORS dependency). The debounce is purely to avoid thrashing the store during a
 * fast pointer pass; there is no async work.
 *
 * React-Compiler-safe: the store's mutable state is only ever written from the
 * handlers/effect below (never read/written in a render or memo position), and
 * the timer ref is handler-and-effect-only too.
 */
function useAmbientDriver(debounceMs = DEFAULT_DEBOUNCE_MS): AmbientDriver {
  const setAmbient = useAmbientThemeStore((s) => s.setAmbient);
  const clearAmbient = useAmbientThemeStore((s) => s.clearAmbient);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const apply = useCallback(
    (colors: AmbientColors) => {
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (colors.primaryColor) {
          setAmbient({ seed: colors.primaryColor, secondarySeed: colors.secondaryColor });
        } else {
          // No server-extracted colour for this item — keep the default preset.
          clearAmbient();
        }
      }, debounceMs);
    },
    [clearTimer, debounceMs, setAmbient, clearAmbient],
  );

  const clear = useCallback(() => {
    clearTimer();
    clearAmbient();
  }, [clearTimer, clearAmbient]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return { apply, clear };
}

export interface HoverAmbient {
  /** Theme the whole app from a hovered card's cover colours. Call on hover-in. */
  onHoverIn: (colors: AmbientColors) => void;
  /** Restore the app's default theme. Call on hover-out. */
  onHoverOut: () => void;
}

/**
 * HOVER MODE (home / browse-grid screens). Wire the returned handlers to
 * `MediaCard`'s `onHoverIn({ primaryColor, secondaryColor })` / `onHoverOut`:
 * hovering a card themes the ENTIRE app from that card's server-extracted cover
 * colours; leaving restores the default. Cards with no `primaryColor` keep the
 * default preset.
 */
export function useHoverAmbient(): HoverAmbient {
  const { apply, clear } = useAmbientDriver();
  return { onHoverIn: apply, onHoverOut: clear };
}

/**
 * VIEW MODE (detail pages: album / artist / playlist / podcast show / episode).
 * Themes the whole app from the item's server-extracted cover colours ON VIEW
 * (mount) and restores the default on leave (unmount). It does NOT theme on
 * hover — the page stays themed the whole time you're on it.
 *
 * The mount/unmount lifecycle IS the view lifecycle here: the root layout renders
 * a single route via `<Slot />`, so a detail screen unmounts when the user
 * navigates away, which fires the cleanup and restores the default theme. Re-runs
 * whenever the colours change (e.g. data loads in after the first paint).
 */
export function useViewAmbient(
  primaryColor: string | undefined,
  secondaryColor: string | undefined,
): void {
  const { apply, clear } = useAmbientDriver();

  useEffect(() => {
    apply({ primaryColor, secondaryColor });
    return () => clear();
  }, [apply, clear, primaryColor, secondaryColor]);
}
