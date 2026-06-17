import { create } from 'zustand';

type FullscreenPanel = 'library' | 'nowPlaying' | null;

interface UIState {
  isNowPlayingVisible: boolean;
  toggleNowPlaying: () => void;
  setNowPlayingVisible: (visible: boolean) => void;
  isLibrarySidebarExpanded: boolean;
  setLibrarySidebarExpanded: (expanded: boolean) => void;
  fullscreenPanel: FullscreenPanel;
  setFullscreenPanel: (panel: FullscreenPanel) => void;
  toggleFullscreen: (panel: 'library' | 'nowPlaying') => void;
  shellGradientColor: string | null;
  setShellGradientColor: (color: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  isNowPlayingVisible: true, // Open by default
  toggleNowPlaying: () => set((state) => ({ isNowPlayingVisible: !state.isNowPlayingVisible })),
  setNowPlayingVisible: (visible: boolean) => set({ isNowPlayingVisible: visible }),
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
  shellGradientColor: null,
  setShellGradientColor: (color: string | null) => set({ shellGradientColor: color }),
}));
