import { api, authenticatedClient } from '@/utils/api';
import {
  Queue,
  QueueWithMetadata,
  AddToQueueRequest,
  PlayableRef,
  RemoveFromQueueRequest,
  ReplaceQueueRequest,
} from '@syra/shared-types';
import { normalizeTrackImages } from '@/utils/catalogImages';

function normalizeQueue<T extends Queue>(queue: T): T {
  return {
    ...queue,
    tracks: queue.tracks.map(normalizeTrackImages),
  };
}

function normalizeQueueWithMetadata(queue: QueueWithMetadata): QueueWithMetadata {
  return {
    ...normalizeQueue(queue),
    previous: queue.previous.map(normalizeTrackImages),
    next: queue.next.map(normalizeTrackImages),
  };
}

/**
 * Queue API service
 * Handles queue operations (add, remove, reorder, clear)
 *
 * Every write addresses items by {@link PlayableRef} — `{ kind, id }` — never by
 * a bare id. The queue spans two collections, so the kind is what decides which
 * one the backend reads and which ownership check it applies: `track` goes
 * through the public catalog filter, `upload` resolves scoped to the caller's own
 * locker. An id on its own would have to be tried against both, which puts the
 * owner check on the second attempt only.
 */
export const queueService = {
  /**
   * Get user's queue
   */
  async getQueue(): Promise<QueueWithMetadata> {
    const response = await api.get<QueueWithMetadata>('/queue');
    return normalizeQueueWithMetadata(response.data);
  },

  /**
   * Add items to the queue.
   */
  async addToQueue(
    refs: PlayableRef[],
    position?: 'next' | 'last' | number
  ): Promise<{ queue: Queue; added: number }> {
    const body: AddToQueueRequest = {
      refs,
      position,
    };
    const response = await api.post<{ queue: Queue; added: number }>('/queue/add', body);
    return { ...response.data, queue: normalizeQueue(response.data.queue) };
  },

  /**
   * Replace user's queue with an ordered playback context.
   */
  async replaceQueue(queue: Queue): Promise<{ queue: Queue }> {
    const body: ReplaceQueueRequest = {
      refs: queue.tracks.map((item) => ({ kind: item.kind, id: item.id })),
      current: queue.current,
      context: queue.context,
    };
    const response = await api.put<{ queue: Queue }>('/queue', body);
    return { ...response.data, queue: normalizeQueue(response.data.queue) };
  },

  /**
   * Remove items from the queue.
   */
  async removeFromQueue(refs: PlayableRef[]): Promise<{ queue: Queue; removed: number }> {
    // Express delete routes can accept body via req.body.
    // authenticatedClient (HttpService) resolves to the parsed body directly.
    const body: RemoveFromQueueRequest = { refs };
    const response = await authenticatedClient.delete<{ queue: Queue; removed: number }>('/queue/remove', {
      data: body,
    });
    return { ...response, queue: normalizeQueue(response.queue) };
  },

  /**
   * Reorder queue items. The refs are the queue's new order in full.
   */
  async reorderQueue(refs: PlayableRef[]): Promise<{ queue: Queue; reordered: number }> {
    const response = await api.put<{ queue: Queue; reordered: number }>('/queue/reorder', {
      refs,
    });
    return { ...response.data, queue: normalizeQueue(response.data.queue) };
  },

  /**
   * Clear queue
   */
  async clearQueue(): Promise<void> {
    await api.delete('/queue/clear');
  },

  /**
   * Set current track index
   */
  async setCurrentIndex(index: number): Promise<{ queue: Queue; currentIndex: number }> {
    const response = await api.put<{ queue: Queue; currentIndex: number }>('/queue/current', {
      index,
    });
    return { ...response.data, queue: normalizeQueue(response.data.queue) };
  },
};
