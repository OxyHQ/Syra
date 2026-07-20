import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

type FullscreenPanel = 'library' | 'nowPlaying' | null;

/**
 * How the library sidebar orders its entries.
 *
 * `type` is the natural grouping the sidebar has always used (liked songs,
 * then playlists, artists and albums). `alphabetical` sorts every entry by
 * title regardless of kind.
 *
 * There is deliberately no "recently added" order: the library membership
 * arrays (`savedAlbums`, `followedArtists`) are bare `string[]` of ids with no
 * per-user timestamp, so a cross-kind recency order cannot be derived on the
 * client without inventing one. See the note on the sort control.
 */
export type LibrarySortOrder = 'type' | 'alphabetical';

interface UIState {
  isNowPlayingVisible: boolean;
  toggleNowPlaying: () => void;
  setNowPlayingVisible: (visible: boolean) => void;
  isLibrarySidebarExpanded: boolean;
  setLibrarySidebarExpanded: (expanded: boolean) => void;
  librarySortOrder: LibrarySortOrder;
  setLibrarySortOrder: (order: LibrarySortOrder) => void;
  fullscreenPanel: FullscreenPanel;
  setFullscreenPanel: (panel: FullscreenPanel) => void;
  toggleFullscreen: (panel: 'library' | 'nowPlaying') => void;
}

/**
 * Panel/sidebar UI state.
 *
 * Only durable *preferences* are persisted — see `partialize` below. Everything
 * else here is session state and is deliberately left to reset on a cold start.
 */
export const useUIStore = create<UIState>()(persist((set) => ({
  isNowPlayingVisible: true, // Open by default
  toggleNowPlaying: () => set((state) => ({ isNowPlayingVisible: !state.isNowPlayingVisible })),
  setNowPlayingVisible: (visible: boolean) => set({ isNowPlayingVisible: visible }),
  // Sidebar sort lives here rather than in the sidebar's own `useState` so the
  // choice survives every collapse, expand and fullscreen toggle — each of
  // those unmounts the expanded view.
  librarySortOrder: 'type',
  setLibrarySortOrder: (order: LibrarySortOrder) => set({ librarySortOrder: order }),
  isLibrarySidebarExpanded: true,
  setLibrarySidebarExpanded: (expanded: boolean) => set((state) => ({
    isLibrarySidebarExpanded: expanded,
    fullscreenPanel: expanded || state.fullscreenPanel !== 'library' ? state.fullscreenPanel : null,
  })),
  fullscreenPanel: null,
  setFullscreenPanel: (panel: FullscreenPanel) => set({ fullscreenPanel: panel }),
  toggleFullscreen: (panel: 'library' | 'nowPlaying') => set((state) => ({
    fullscreenPanel: state.fullscreenPanel === panel ? null : panel,
    isLibrarySidebarExpanded: panel === 'library' ? true : state.isLibrarySidebarExpanded,
  })),
}), {
  name: 'syra.ui-preferences',
  // AsyncStorage is this app's local-persistence mechanism (see
  // `lib/queryPersister.ts`); on web it resolves to localStorage. Unlike the
  // appearance settings, which round-trip through `/profile/settings`, this is
  // a device preference: it must work for signed-out visitors too, so it stays
  // local and unscoped rather than server-backed and auth-gated.
  storage: createJSONStorage(() => AsyncStorage),
  version: 1,
  // ONLY the sort preference is restored. The rest of this store is session
  // state that would be actively wrong to bring back on a cold start —
  // `fullscreenPanel` most of all: restoring `'nowPlaying'` would open a
  // full-screen player on boot with nothing playing.
  partialize: (state) => ({ librarySortOrder: state.librarySortOrder }),
}));
