import { api, authenticatedClient } from '@/utils/api';
import { Queue, QueueWithMetadata, AddToQueueRequest } from '@syra/shared-types';

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
    return response.data;
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
    return response.data;
  },

  /**
   * Remove tracks from queue
   */
  async removeFromQueue(trackIds: string[]): Promise<{ queue: Queue; removed: number }> {
    // Express delete routes can accept body via req.body
    const response = await authenticatedClient.delete('/queue/remove', {
      data: { trackIds },
    });
    return response.data;
  },

  /**
   * Reorder queue tracks
   */
  async reorderQueue(trackIds: string[]): Promise<{ queue: Queue; reordered: number }> {
    const response = await api.put<{ queue: Queue; reordered: number }>('/queue/reorder', {
      trackIds,
    });
    return response.data;
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
    return response.data;
  },
};

