import { create } from 'zustand';

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
 * The seeds are the catalog's SERVER-EXTRACTED cover colours (`primaryColor` /
 * `secondaryColor` on every catalog DTO), fed in by the `useAmbientArtwork`
 * driver — there is no client-side pixel extraction. Catalog DTOs carry no
 * tertiary, so `tertiarySeed` is always `null` here (Bloom derives it from the
 * seed).
 *
 * There is exactly ONE writer path (the `useAmbientArtwork` driver, via its
 * hover/view entry points) and ONE reader path (the root provider). Screens
 * never write here directly.
 */
export interface AmbientSeeds {
  /** Dominant cover colour (`#rrggbb`); drives the app-wide theme. */
  seed: string;
  /** Supporting cover colour (`#rrggbb`), pinned as the secondary accent. */
  secondarySeed?: string | null;
}

interface AmbientThemeState {
  /** Dominant cover colour (`#rrggbb`), or `null` for the default preset. */
  seed: string | null;
  /** Pinned secondary accent (`#rrggbb`) for the active seed, if any. */
  secondarySeed: string | null;
  /** Pinned tertiary accent (`#rrggbb`); always `null` (no DTO tertiary). */
  tertiarySeed: string | null;
  /** Theme the whole app from a cover's colours. */
  setAmbient: (seeds: AmbientSeeds) => void;
  /** Restore the app's default preset theme. */
  clearAmbient: () => void;
}

export const useAmbientThemeStore = create<AmbientThemeState>((set) => ({
  seed: null,
  secondarySeed: null,
  tertiarySeed: null,
  setAmbient: (seeds: AmbientSeeds) =>
    set({
      seed: seeds.seed,
      secondarySeed: seeds.secondarySeed ?? null,
      tertiarySeed: null,
    }),
  clearAmbient: () => set({ seed: null, secondarySeed: null, tertiarySeed: null }),
}));
