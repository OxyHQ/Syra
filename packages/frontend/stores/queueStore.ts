import { create } from 'zustand';
import { Queue, QueueWithMetadata, Track, RepeatMode, ShuffleMode } from '@syra/shared-types';
import { queueService } from '../services/queueService';

const RECOVERABLE_CURRENT_INDEX_ERRORS = new Set(['Queue not found', 'Index out of bounds']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStatus(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }

  if (typeof error.status === 'number') {
    return error.status;
  }

  if (isRecord(error.response) && typeof error.response.status === 'number') {
    return error.response.status;
  }

  return null;
}

function getPayloadMessage(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (typeof payload.error === 'string') {
    return payload.error;
  }

  if (typeof payload.message === 'string') {
    return payload.message;
  }

  return null;
}

function getErrorMessage(error: unknown): string | null {
  const directMessage = getPayloadMessage(error);
  if (directMessage) {
    return directMessage;
  }

  if (isRecord(error)) {
    const dataMessage = getPayloadMessage(error.data);
    if (dataMessage) {
      return dataMessage;
    }

    if (isRecord(error.response)) {
      const responseMessage = getPayloadMessage(error.response);
      if (responseMessage) {
        return responseMessage;
      }

      const responseDataMessage = getPayloadMessage(error.response.data);
      if (responseDataMessage) {
        return responseDataMessage;
      }
    }
  }

  return error instanceof Error ? error.message : null;
}

function isRecoverableCurrentIndexError(error: unknown): boolean {
  const status = getStatus(error);
  const message = getErrorMessage(error);
  return status === 400 && typeof message === 'string' && RECOVERABLE_CURRENT_INDEX_ERRORS.has(message);
}

function userFacingError(error: unknown, fallback: string): string {
  return getErrorMessage(error) ?? fallback;
}

function queueWithInsertedTracks(
  queue: Queue | null,
  tracks: Track[],
  position?: 'next' | 'last' | number,
): Queue {
  const baseQueue = queue ?? {
    current: -1,
    tracks: [],
  };

  let insertIndex: number;
  if (position === 'next') {
    insertIndex = baseQueue.current >= 0 ? baseQueue.current + 1 : 0;
  } else if (position === 'last' || position === undefined) {
    insertIndex = baseQueue.tracks.length;
  } else {
    insertIndex = Math.max(0, Math.min(position, baseQueue.tracks.length));
  }

  const nextTracks = [...baseQueue.tracks];
  nextTracks.splice(insertIndex, 0, ...tracks);

  return {
    ...baseQueue,
    current: baseQueue.current >= insertIndex ? baseQueue.current + tracks.length : baseQueue.current,
    tracks: nextTracks,
  };
}

interface QueueState {
  queue: Queue | null;
  shuffle: ShuffleMode;
  repeat: RepeatMode;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadQueue: () => Promise<void>;
  addToQueue: (trackIds: string[], position?: 'next' | 'last' | number) => Promise<void>;
  replaceQueue: (queue: Queue) => Promise<void>;
  addTracksLocally: (tracks: Track[], position?: 'next' | 'last' | number) => Promise<void>;
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

  replaceQueue: async (queue: Queue) => {
    const previousQueue = get().queue;
    set({ queue, error: null });

    try {
      const result = await queueService.replaceQueue(queue);
      set({ queue: result.queue });
    } catch (error) {
      console.error('[QueueStore] Error replacing queue:', error);
      set({
        queue: previousQueue,
        error: error instanceof Error ? error.message : 'Failed to replace queue',
      });
    }
  },

  addTracksLocally: async (tracks: Track[], position?: 'next' | 'last' | number) => {
    if (tracks.length === 0) {
      return;
    }

    const previousQueue = get().queue;
    set({ queue: queueWithInsertedTracks(previousQueue, tracks, position), error: null });

    try {
      const result = await queueService.addToQueue(tracks.map((track) => track.id), position);
      set({ queue: result.queue });
    } catch (error) {
      console.error('[QueueStore] Error adding local tracks to queue:', error);
      set({
        queue: previousQueue,
        error: error instanceof Error ? error.message : 'Failed to add to queue',
      });
    }
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
    if (queue.current === index) {
      return;
    }

    set({ queue: { ...queue, current: index } });

    try {
      const result = await queueService.setCurrentIndex(index);
      set({ queue: result.queue });
    } catch (error) {
      if (isRecoverableCurrentIndexError(error)) {
        const currentQueue = get().queue;
        if (!currentQueue || index < 0 || index >= currentQueue.tracks.length) {
          return;
        }

        const repairedQueue = { ...currentQueue, current: index };
        try {
          const result = await queueService.replaceQueue(repairedQueue);
          set({ queue: result.queue, error: null });
        } catch (repairError) {
          console.error('[QueueStore] Error repairing queue current index:', repairError);
          set({ error: userFacingError(repairError, 'Failed to repair queue') });
        }
        return;
      }

      console.error('[QueueStore] Error setting current index:', error);
      set({ error: userFacingError(error, 'Failed to update current track') });
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
