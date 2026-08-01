import { PlayableItem, PlayableRef, Queue } from '@syra/shared-types';
import { getRedisClient } from '../utils/redis';
import { logger } from '../utils/logger';

const QUEUE_KEY_PREFIX = 'queue:';
const QUEUE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * A queue entry's identity is (kind, id), not id alone.
 *
 * The queue now holds two kinds of item from two collections. Addressing an entry
 * by bare id happens to work while every id is a distinct ObjectId, but it
 * encodes an assumption nothing enforces — and the entry it would remove or
 * reorder by accident is somebody's private file.
 *
 * Anything that is not explicitly an upload is a catalog track, which also
 * absorbs the queues already sitting in Redis when this shipped: they were
 * written as untagged tracks, nothing re-parses them on read, and they expire on
 * their own within a day.
 */
function refKey(ref: PlayableRef | PlayableItem): string {
  return ref.kind === 'upload' ? `upload:${ref.id}` : `track:${ref.id}`;
}

/**
 * Get queue key for a user
 */
function getQueueKey(userId: string): string {
  return `${QUEUE_KEY_PREFIX}${userId}`;
}

/**
 * Get queue for a user from Redis
 */
export async function getQueue(userId: string): Promise<Queue | null> {
  try {
    const redis = getRedisClient();
    if (!redis.isReady) {
      logger.warn('Redis not ready, returning null queue');
      return null;
    }

    const key = getQueueKey(userId);
    const data = await redis.get(key);

    if (!data) {
      return null;
    }

    const queue = JSON.parse(data) as Queue;
    return queue;
  } catch (error) {
    logger.error('[QueueService] Error getting queue:', error);
    return null;
  }
}

/**
 * Set queue for a user in Redis
 */
export async function setQueue(userId: string, queue: Queue): Promise<boolean> {
  try {
    const redis = getRedisClient();
    if (!redis.isReady) {
      logger.warn('Redis not ready, cannot set queue');
      return false;
    }

    const key = getQueueKey(userId);
    const data = JSON.stringify(queue);

    // Set with TTL
    await redis.setEx(key, QUEUE_TTL_SECONDS, data);
    return true;
  } catch (error) {
    logger.error('[QueueService] Error setting queue:', error);
    return false;
  }
}

/**
 * Add tracks to queue
 */
export async function addTracks(
  userId: string,
  tracks: PlayableItem[],
  position?: 'next' | 'last' | number
): Promise<Queue | null> {
  try {
    const redis = getRedisClient();
    if (!redis.isReady) {
      logger.warn('Redis not ready, cannot add tracks to queue');
      return null;
    }

    let queue = await getQueue(userId);
    
    // Initialize queue if it doesn't exist
    if (!queue) {
      queue = {
        current: -1,
        tracks: [],
      };
    }

    // Determine insertion position
    let insertIndex: number;
    if (position === 'next') {
      // Insert after current track
      insertIndex = queue.current >= 0 ? queue.current + 1 : 0;
    } else if (position === 'last') {
      // Append to end
      insertIndex = queue.tracks.length;
    } else if (typeof position === 'number') {
      // Insert at specific index
      insertIndex = Math.max(0, Math.min(position, queue.tracks.length));
    } else {
      // Default: append to end
      insertIndex = queue.tracks.length;
    }

    // Insert tracks
    queue.tracks.splice(insertIndex, 0, ...tracks);

    // Update current index if needed
    if (queue.current >= insertIndex) {
      queue.current += tracks.length;
    }

    // Save to Redis
    await setQueue(userId, queue);
    return queue;
  } catch (error) {
    logger.error('[QueueService] Error adding tracks to queue:', error);
    return null;
  }
}

/**
 * Remove tracks from queue
 */
export async function removeTracks(
  userId: string,
  refs: PlayableRef[]
): Promise<Queue | null> {
  try {
    const redis = getRedisClient();
    if (!redis.isReady) {
      logger.warn('Redis not ready, cannot remove tracks from queue');
      return null;
    }

    const queue = await getQueue(userId);
    if (!queue || queue.tracks.length === 0) {
      return queue;
    }

    // Create set for fast lookup
    const doomedKeys = new Set(refs.map(refKey));

    // Remove tracks and track indices
    const indicesToRemove: number[] = [];
    queue.tracks = queue.tracks.filter((track, index) => {
      if (doomedKeys.has(refKey(track))) {
        indicesToRemove.push(index);
        return false;
      }
      return true;
    });

    // Update current index
    if (queue.current >= 0) {
      // Count how many removed tracks were before current
      const removedBeforeCurrent = indicesToRemove.filter(idx => idx < queue.current).length;
      queue.current = Math.max(-1, queue.current - removedBeforeCurrent);
      
      // If current track was removed, adjust
      if (indicesToRemove.includes(queue.current)) {
        // Move to next track, or previous if at end
        if (queue.tracks.length > 0) {
          queue.current = Math.min(queue.current, queue.tracks.length - 1);
        } else {
          queue.current = -1;
        }
      }
    }

    // Save to Redis
    await setQueue(userId, queue);
    return queue;
  } catch (error) {
    logger.error('[QueueService] Error removing tracks from queue:', error);
    return null;
  }
}

/**
 * Reorder queue tracks
 */
export async function reorderQueue(
  userId: string,
  newOrder: PlayableRef[]
): Promise<Queue | null> {
  try {
    const redis = getRedisClient();
    if (!redis.isReady) {
      logger.warn('Redis not ready, cannot reorder queue');
      return null;
    }

    const queue = await getQueue(userId);
    if (!queue || queue.tracks.length === 0) {
      return queue;
    }

    // Create map for fast lookup
    const trackMap = new Map(queue.tracks.map(track => [refKey(track), track]));
    const orderedKeys = newOrder.map(refKey);
    const orderedKeySet = new Set(orderedKeys);

    // Build new tracks array in specified order
    const newTracks: PlayableItem[] = [];
    for (const key of orderedKeys) {
      const track = trackMap.get(key);
      if (track) {
        newTracks.push(track);
      }
    }

    // Add any remaining tracks that weren't in newOrder
    for (const track of queue.tracks) {
      if (!orderedKeySet.has(refKey(track))) {
        newTracks.push(track);
      }
    }

    queue.tracks = newTracks;

    // Update current index to point to same track
    if (queue.current >= 0 && queue.tracks.length > 0) {
      const oldCurrentTrack = queue.tracks[queue.current];
      if (oldCurrentTrack) {
        const oldKey = refKey(oldCurrentTrack);
        const newIndex = newTracks.findIndex(t => refKey(t) === oldKey);
        queue.current = newIndex >= 0 ? newIndex : 0;
      }
    }

    // Save to Redis
    await setQueue(userId, queue);
    return queue;
  } catch (error) {
    logger.error('[QueueService] Error reordering queue:', error);
    return null;
  }
}

/**
 * Clear queue
 */
export async function clearQueue(userId: string): Promise<boolean> {
  try {
    const redis = getRedisClient();
    if (!redis.isReady) {
      logger.warn('Redis not ready, cannot clear queue');
      return false;
    }

    const key = getQueueKey(userId);
    await redis.del(key);
    return true;
  } catch (error) {
    logger.error('[QueueService] Error clearing queue:', error);
    return false;
  }
}

/**
 * Set current track index in queue
 */
export async function setCurrentIndex(userId: string, index: number): Promise<Queue | null> {
  try {
    const queue = await getQueue(userId);
    if (!queue) {
      return null;
    }

    if (index < 0 || index >= queue.tracks.length) {
      return queue;
    }

    queue.current = index;
    await setQueue(userId, queue);
    return queue;
  } catch (error) {
    logger.error('[QueueService] Error setting current index:', error);
    return null;
  }
}

/**
 * Get next track in queue
 */
export async function getNextTrack(userId: string): Promise<PlayableItem | null> {
  try {
    const queue = await getQueue(userId);
    if (!queue || queue.tracks.length === 0) {
      return null;
    }

    const nextIndex = queue.current + 1;
    if (nextIndex >= queue.tracks.length) {
      return null;
    }

    return queue.tracks[nextIndex] || null;
  } catch (error) {
    logger.error('[QueueService] Error getting next track:', error);
    return null;
  }
}

/**
 * Get previous track in queue
 */
export async function getPreviousTrack(userId: string): Promise<PlayableItem | null> {
  try {
    const queue = await getQueue(userId);
    if (!queue || queue.tracks.length === 0) {
      return null;
    }

    const prevIndex = queue.current - 1;
    if (prevIndex < 0) {
      return null;
    }

    return queue.tracks[prevIndex] || null;
  } catch (error) {
    logger.error('[QueueService] Error getting previous track:', error);
    return null;
  }
}






