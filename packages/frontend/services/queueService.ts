import { api, authenticatedClient } from '@/utils/api';
import { Queue, QueueWithMetadata, AddToQueueRequest, ReplaceQueueRequest } from '@syra/shared-types';
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
   * Add tracks to queue
   */
  async addToQueue(
    trackIds: string[],
    position?: 'next' | 'last' | number
  ): Promise<{ queue: Queue; added: number }> {
    const body: AddToQueueRequest = {
      trackIds,
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
      trackIds: queue.tracks.map((track) => track.id),
      current: queue.current,
      context: queue.context,
    };
    const response = await api.put<{ queue: Queue }>('/queue', body);
    return { ...response.data, queue: normalizeQueue(response.data.queue) };
  },

  /**
   * Remove tracks from queue
   */
  async removeFromQueue(trackIds: string[]): Promise<{ queue: Queue; removed: number }> {
    // Express delete routes can accept body via req.body.
    // authenticatedClient (HttpService) resolves to the parsed body directly.
    const response = await authenticatedClient.delete<{ queue: Queue; removed: number }>('/queue/remove', {
      data: { trackIds },
    });
    return { ...response, queue: normalizeQueue(response.queue) };
  },

  /**
   * Reorder queue tracks
   */
  async reorderQueue(trackIds: string[]): Promise<{ queue: Queue; reordered: number }> {
    const response = await api.put<{ queue: Queue; reordered: number }>('/queue/reorder', {
      trackIds,
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
