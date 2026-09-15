import { create } from 'zustand';
import {
  Queue,
  QueueWithMetadata,
  PlayableItem,
  PlayableRef,
  RepeatMode,
  ShuffleMode,
} from '@syra/shared-types';
import { queueService } from '../services/queueService';
import { isUnauthorizedError } from '../utils/api';
import { moveQueueOccurrence, removeQueueOccurrence } from '../utils/queue-occurrences';

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

function queueWithInsertedItems(
  queue: Queue | null,
  items: PlayableItem[],
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
  nextTracks.splice(insertIndex, 0, ...items);

  return {
    ...baseQueue,
    current: baseQueue.current >= insertIndex ? baseQueue.current + items.length : baseQueue.current,
    tracks: nextTracks,
  };
}

interface QueueState {
  accountId: string | null | undefined;
  accountSession: number;
  revision: number;
  setAccount: (accountId: string | null) => void;
  moveOccurrence: (from: number, to: number) => Promise<void>;
  removeOccurrence: (index: number) => Promise<void>;
  queue: Queue | null;
  shuffle: ShuffleMode;
  repeat: RepeatMode;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadQueue: () => Promise<void>;
  addToQueue: (refs: PlayableRef[], position?: 'next' | 'last' | number) => Promise<void>;
  replaceQueue: (queue: Queue) => Promise<void>;
  /**
   * Append items the caller already holds in full, so the queue updates before
   * the round trip. Takes items rather than refs precisely because it renders
   * them optimistically — a ref alone would have nothing to show.
   */
  addTracksLocally: (items: PlayableItem[], position?: 'next' | 'last' | number) => Promise<void>;
  removeFromQueue: (refs: PlayableRef[]) => Promise<void>;
  reorderQueue: (refs: PlayableRef[]) => Promise<void>;
  clearQueue: () => Promise<void>;
  setCurrentIndex: (index: number) => Promise<void>;
  playNext: () => Promise<void>;
  playPrevious: () => Promise<void>;
  setShuffle: (shuffle: ShuffleMode) => void;
  setRepeat: (repeat: RepeatMode) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  syncQueue: (queue: Queue, source?: 'socket') => void; // For socket updates
}

// Requests are ordered at the boundary so a slow replace cannot land after
// a newer append. The returned promise still rejects to the action that owns
// error reporting; the recovered tail only allows the following request to run.
let requestTail: Promise<unknown> = Promise.resolve();
let queuedRequests = 0;
function orderedRequest<T>(session: number, action: () => Promise<T>): Promise<T> {
  queuedRequests += 1;
  const result = requestTail.then(() => {
    if (useQueueStore.getState().accountSession !== session) throw new Error('Queue account changed');
    return action();
  }).finally(() => {
    if (useQueueStore.getState().accountSession === session) queuedRequests -= 1;
  });
  requestTail = result.then(() => undefined, () => undefined);
  return result;
}
function beginRequest() {
  const { accountSession, revision } = useQueueStore.getState();
  useQueueStore.setState({ revision: revision + 1 });
  return { accountSession, revision: revision + 1 };
}
function isCurrent(request: { accountSession: number; revision: number }): boolean {
  const state = useQueueStore.getState();
  return state.accountSession === request.accountSession && state.revision === request.revision;
}

export const useQueueStore = create<QueueState>((set, get) => ({
  accountId: undefined,
  accountSession: 0,
  revision: 0,
  setAccount: (accountId) => {
    if (get().accountId === accountId) return;
    requestTail = Promise.resolve();
    queuedRequests = 0;
    set({ accountId, accountSession: get().accountSession + 1, revision: get().revision + 1, queue: null, shuffle: 'off', repeat: RepeatMode.OFF, error: null, isLoading: false });
  },
  moveOccurrence: async (from, to) => {
    const queue = get().queue;
    if (!queue) return;
    const next = moveQueueOccurrence(queue, from, to);
    if (next !== queue) await get().replaceQueue(next);
  },
  removeOccurrence: async (index) => {
    const queue = get().queue;
    if (!queue) return;
    const next = removeQueueOccurrence(queue, index);
    if (next !== queue) await get().replaceQueue(next);
  },
  queue: null,
  shuffle: 'off',
  repeat: RepeatMode.OFF,
  isLoading: false,
  error: null,

  loadQueue: async () => {
    const request = beginRequest();
    try {
      set({ isLoading: true, error: null });
      const queueData = await orderedRequest(request.accountSession, () => queueService.getQueue());
      if (!isCurrent(request)) return;
      set({ queue: queueData, isLoading: false });
    } catch (error) {
      if (!isCurrent(request)) return;
      console.error('[QueueStore] Error loading queue:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to load queue',
        isLoading: false,
      });
    }
  },

  addToQueue: async (refs: PlayableRef[], position?: 'next' | 'last' | number) => {
    const request = beginRequest();
    try {
      set({ isLoading: true, error: null });
      const result = await orderedRequest(request.accountSession, () => queueService.addToQueue(refs, position));
      if (!isCurrent(request)) return;
      set({ queue: result.queue, isLoading: false });
    } catch (error) {
      if (!isCurrent(request)) return;
      console.error('[QueueStore] Error adding to queue:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to add to queue',
        isLoading: false,
      });
    }
  },

  replaceQueue: async (queue: Queue) => {
    if (!queue.tracks.length) { await get().clearQueue(); return; }
    const request = beginRequest();
    const previousQueue = get().queue;
    set({ queue, error: null, isLoading: false });

    try {
      const result = await orderedRequest(request.accountSession, () => queueService.replaceQueue(queue));
      if (!isCurrent(request)) return;
      set({ queue: result.queue });
    } catch (error) {
      if (!isCurrent(request)) return;
      // `PUT /queue` sits behind requireAuth, so a guest cannot have a
      // server-side queue at all — reverting would wipe the queue they just
      // started playing. Theirs is legitimately local-only. The optimistic set
      // above already cleared the error, so there is nothing left to clear.
      if (isUnauthorizedError(error)) {
        return;
      }

      console.error('[QueueStore] Error replacing queue:', error);
      set({
        queue: previousQueue,
        error: error instanceof Error ? error.message : 'Failed to replace queue',
      });
    }
  },

  addTracksLocally: async (items: PlayableItem[], position?: 'next' | 'last' | number) => {
    if (items.length === 0) {
      return;
    }
    const request = beginRequest();

    const previousQueue = get().queue;
    set({ queue: queueWithInsertedItems(previousQueue, items, position), error: null, isLoading: false });

    try {
      const result = await orderedRequest(request.accountSession, () => queueService.addToQueue(
        items.map((item) => ({ kind: item.kind, id: item.id })),
        position,
      ));
      if (!isCurrent(request)) return;
      set({ queue: result.queue });
    } catch (error) {
      if (!isCurrent(request)) return;
      // Same as replaceQueue: `POST /queue/add` requires auth, so for a guest
      // every radio append would otherwise revert and silently empty the queue.
      if (isUnauthorizedError(error)) {
        return;
      }

      console.error('[QueueStore] Error adding local tracks to queue:', error);
      set({
        queue: previousQueue,
        error: error instanceof Error ? error.message : 'Failed to add to queue',
      });
    }
  },

  removeFromQueue: async (refs: PlayableRef[]) => {
    const request = beginRequest();
    try {
      set({ isLoading: true, error: null });
      const result = await orderedRequest(request.accountSession, () => queueService.removeFromQueue(refs));
      if (!isCurrent(request)) return;
      set({ queue: result.queue, isLoading: false });
    } catch (error) {
      if (!isCurrent(request)) return;
      console.error('[QueueStore] Error removing from queue:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to remove from queue',
        isLoading: false,
      });
    }
  },

  reorderQueue: async (refs: PlayableRef[]) => {
    const request = beginRequest();
    try {
      set({ isLoading: true, error: null });
      const result = await orderedRequest(request.accountSession, () => queueService.reorderQueue(refs));
      if (!isCurrent(request)) return;
      set({ queue: result.queue, isLoading: false });
    } catch (error) {
      if (!isCurrent(request)) return;
      console.error('[QueueStore] Error reordering queue:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to reorder queue',
        isLoading: false,
      });
    }
  },

  clearQueue: async () => {
    const request = beginRequest();
    set({ queue: { current: -1, tracks: [] }, error: null });
    try {
      set({ isLoading: true, error: null });
      await orderedRequest(request.accountSession, () => queueService.clearQueue());
      if (!isCurrent(request)) return;
      set({
        queue: { current: -1, tracks: [] },
        isLoading: false,
      });
    } catch (error) {
      if (!isCurrent(request)) return;
      if (isUnauthorizedError(error)) { set({ isLoading: false }); return; }
      console.error('[QueueStore] Error clearing queue:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to clear queue',
        isLoading: false,
      });
    }
  },

  setCurrentIndex: async (index: number) => {
    const { queue } = get();
    if (!queue || !Number.isInteger(index) || index < 0 || index >= queue.tracks.length) {
      return;
    }
    if (queue.current === index) {
      return;
    }
    const request = beginRequest();

    set({ queue: { ...queue, current: index }, isLoading: false, error: null });

    try {
      const result = await orderedRequest(request.accountSession, () => queueService.setCurrentIndex(index));
      if (!isCurrent(request)) return;
      set({ queue: result.queue });
    } catch (error) {
      if (!isCurrent(request)) return;
      if (isRecoverableCurrentIndexError(error)) {
        const currentQueue = get().queue;
        if (!currentQueue || index < 0 || index >= currentQueue.tracks.length) {
          return;
        }

        const repairedQueue = { ...currentQueue, current: index };
        try {
          const result = await orderedRequest(request.accountSession, () => queueService.replaceQueue(repairedQueue));
          if (!isCurrent(request)) return;
          set({ queue: result.queue, error: null });
        } catch (repairError) {
          if (!isCurrent(request)) return;
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

  syncQueue: (queue: Queue, source) => {
    if (source === 'socket' && queuedRequests > 0) return;
    set({ queue, revision: get().revision + 1 });
  },
}));
