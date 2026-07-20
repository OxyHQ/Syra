import { create } from 'zustand';

import type { ArtworkSeeds } from '@/utils/artworkSeed.types';

/**
 * App-wide ambient-theme store.
 *
 * Holds the single dynamic seed trio that themes the WHOLE app (sidebar,
 * background, shell — everything). The root `<BloomThemeProvider>` subscribes to
 * this store and forwards `seed` / `secondarySeed` / `tertiarySeed` as its
 * `seed` / `secondaryColor` / `tertiaryColor` props, so setting a trio re-themes
 * the entire app from a piece of artwork and clearing it restores the app's
 * default preset.
 *
 * There is exactly ONE writer path (the `useAmbientArtwork` driver, via its
 * hover/view entry points) and ONE reader path (the root provider). Screens
 * never write here directly.
 */
interface AmbientThemeState {
  /** Dominant artwork colour (`#rrggbb`), or `null` for the default preset. */
  seed: string | null;
  /** Pinned secondary accent (`#rrggbb`) for the active seed, if any. */
  secondarySeed: string | null;
  /** Pinned tertiary accent (`#rrggbb`) for the active seed, if any. */
  tertiarySeed: string | null;
  /** Theme the whole app from an extracted artwork trio. */
  setAmbient: (trio: ArtworkSeeds) => void;
  /** Restore the app's default preset theme. */
  clearAmbient: () => void;
}

export const useAmbientThemeStore = create<AmbientThemeState>((set) => ({
  seed: null,
  secondarySeed: null,
  tertiarySeed: null,
  setAmbient: (trio: ArtworkSeeds) =>
    set({
      seed: trio.seed,
      secondarySeed: trio.secondarySeed ?? null,
      tertiarySeed: trio.tertiarySeed ?? null,
    }),
  clearAmbient: () => set({ seed: null, secondarySeed: null, tertiarySeed: null }),
}));
