import { create } from 'zustand';
import { Queue, QueueWithMetadata, Track, RepeatMode, ShuffleMode } from '@syra/shared-types';
import { queueService } from '../services/queueService';

interface QueueState {
  queue: Queue | null;
  shuffle: ShuffleMode;
  repeat: RepeatMode;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadQueue: () => Promise<void>;
  addToQueue: (trackIds: string[], position?: 'next' | 'last' | number) => Promise<void>;
  addTracksLocally: (tracks: Track[], position?: 'next' | 'last' | number) => void;
  removeFromQueue: (trackIds: string[]) => Promise<void>;
  reorderQueue: (trackIds: string[]) => Promise<void>;
  clearQueue: () => Promise<void>;
  setCurrentIndex: (index: number) => Promise<void>;
  playNext: () => Promise<void>;
  playPrevious: () => Promise<void>;
  setShuffle: (shuffle: ShuffleMode) => void;
  setRepeat: (repeat: RepeatMode) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  syncQueue: (queue: Queue) => void; // For socket updates
}

export const useQueueStore = create<QueueState>((set, get) => ({
  queue: null,
  shuffle: 'off',
  repeat: RepeatMode.OFF,
  isLoading: false,
  error: null,

  loadQueue: async () => {
    try {
      set({ isLoading: true, error: null });
      const queueData = await queueService.getQueue();
      set({ queue: queueData, isLoading: false });
    } catch (error) {
      console.error('[QueueStore] Error loading queue:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to load queue',
        isLoading: false,
      });
    }
  },

  addToQueue: async (trackIds: string[], position?: 'next' | 'last' | number) => {
    try {
      set({ isLoading: true, error: null });
      const result = await queueService.addToQueue(trackIds, position);
      set({ queue: result.queue, isLoading: false });
    } catch (error) {
      console.error('[QueueStore] Error adding to queue:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to add to queue',
        isLoading: false,
      });
    }
  },

  addTracksLocally: (tracks: Track[], position?: 'next' | 'last' | number) => {
    if (tracks.length === 0) {
      return;
    }

    set((state) => {
      const queue = state.queue ?? {
        current: -1,
        tracks: [],
      };

      let insertIndex: number;
      if (position === 'next') {
        insertIndex = queue.current >= 0 ? queue.current + 1 : 0;
      } else if (position === 'last' || position === undefined) {
        insertIndex = queue.tracks.length;
      } else {
        insertIndex = Math.max(0, Math.min(position, queue.tracks.length));
      }

      const nextTracks = [...queue.tracks];
      nextTracks.splice(insertIndex, 0, ...tracks);

      return {
        queue: {
          ...queue,
          current: queue.current >= insertIndex ? queue.current + tracks.length : queue.current,
          tracks: nextTracks,
        },
      };
    });
  },

  removeFromQueue: async (trackIds: string[]) => {
    try {
      set({ isLoading: true, error: null });
      const result = await queueService.removeFromQueue(trackIds);
      set({ queue: result.queue, isLoading: false });
    } catch (error) {
      console.error('[QueueStore] Error removing from queue:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to remove from queue',
        isLoading: false,
      });
    }
  },

  reorderQueue: async (trackIds: string[]) => {
    try {
      set({ isLoading: true, error: null });
      const result = await queueService.reorderQueue(trackIds);
      set({ queue: result.queue, isLoading: false });
    } catch (error) {
      console.error('[QueueStore] Error reordering queue:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to reorder queue',
        isLoading: false,
      });
    }
  },

  clearQueue: async () => {
    try {
      set({ isLoading: true, error: null });
      await queueService.clearQueue();
      set({
        queue: { current: -1, tracks: [] },
        isLoading: false,
      });
    } catch (error) {
      console.error('[QueueStore] Error clearing queue:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to clear queue',
        isLoading: false,
      });
    }
  },

  setCurrentIndex: async (index: number) => {
    const { queue } = get();
    if (!queue || index < 0 || index >= queue.tracks.length) {
      return;
    }

    set({ queue: { ...queue, current: index } });

    try {
      await queueService.setCurrentIndex(index);
    } catch (error) {
      console.error('[QueueStore] Error setting current index:', error);
    }
  },

  playNext: async () => {
    const { queue } = get();
    if (!queue || queue.tracks.length === 0) return;

    const nextIndex = queue.current + 1;
    if (nextIndex < queue.tracks.length) {
      await get().setCurrentIndex(nextIndex);
    } else if (get().repeat === RepeatMode.ALL) {
      // Loop to beginning
      await get().setCurrentIndex(0);
    }
  },

  playPrevious: async () => {
    const { queue } = get();
    if (!queue || queue.tracks.length === 0) return;

    const prevIndex = queue.current - 1;
    if (prevIndex >= 0) {
      await get().setCurrentIndex(prevIndex);
    } else if (get().repeat === RepeatMode.ALL) {
      // Loop to end
      await get().setCurrentIndex(queue.tracks.length - 1);
    }
  },

  setShuffle: (shuffle: ShuffleMode) => {
    set({ shuffle });
  },

  setRepeat: (repeat: RepeatMode) => {
    set({ repeat });
  },

  toggleShuffle: () => {
    set((state) => ({ shuffle: state.shuffle === 'on' ? 'off' : 'on' }));
  },

  cycleRepeat: () => {
    set((state) => {
      const repeat =
        state.repeat === RepeatMode.OFF
          ? RepeatMode.ALL
          : state.repeat === RepeatMode.ALL
            ? RepeatMode.ONE
            : RepeatMode.OFF;
      return { repeat };
    });
  },

  syncQueue: (queue: Queue) => {
    set({ queue });
  },
}));



