import { Server as SocketIOServer, Socket } from 'socket.io';
import { logger } from '../utils/logger';
import { PlaybackStateUpdate, Queue } from '@syra/shared-types';
import { getQueue, setCurrentIndex } from '../services/queueService';

interface AuthenticatedSocket extends Socket {
  user?: {
    id: string;
  };
}

/**
 * Setup player socket namespace for real-time playback synchronization
 */
export const setupPlayerSocket = (io: SocketIOServer) => {
  const playerNamespace = io.of('/player');

  // Authentication middleware
  playerNamespace.use((socket: AuthenticatedSocket, next) => {
    try {
      const auth = socket.handshake?.auth as any;
      const userId = auth?.userId || auth?.id || auth?.user?.id;
      if (userId && typeof userId === 'string') {
        socket.user = { id: userId };
      }
      next();
    } catch (error) {
      next(new Error('Authentication failed'));
    }
  });

  playerNamespace.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.user?.id;

    if (!userId) {
      logger.warn(`Player socket connection without userId: ${socket.id}`);
      socket.disconnect();
      return;
    }

    logger.info(`Client connected to player namespace: ${socket.id} (user: ${userId})`);

    // Join user's player room for cross-device sync
    const playerRoom = `player:${userId}`;
    socket.join(playerRoom);
    logger.debug(`Client ${socket.id} joined player room: ${playerRoom}`);

    /**
     * Handle join:player event (redundant but explicit)
     */
    socket.on('join:player', () => {
      socket.join(playerRoom);
      logger.debug(`Client ${socket.id} explicitly joined player room`);
    });

    /**
     * Handle playback state updates
     * Broadcast to all user's devices
     */
    socket.on('playback:state', async (update: PlaybackStateUpdate) => {
      try {
        // Broadcast to all user's devices (excluding sender)
        socket.to(playerRoom).emit('playback:state', update);
        logger.debug(`Broadcasted playback state update for user ${userId}`);
      } catch (error) {
        logger.error(`Error handling playback:state:`, error);
      }
    });

    /**
     * Handle queue updates
     * Broadcast to all user's devices
     */
    socket.on('queue:update', async (queue: Queue) => {
      try {
        // Broadcast to all user's devices (excluding sender)
        socket.to(playerRoom).emit('queue:update', queue);
        logger.debug(`Broadcasted queue update for user ${userId}`);
      } catch (error) {
        logger.error(`Error handling queue:update:`, error);
      }
    });

    /**
     * Handle track change
     * Update queue current index and broadcast
     */
    socket.on('track:change', async (data: { trackId?: string; index?: number; direction?: 'next' | 'previous' }) => {
      try {
        const { trackId, index, direction } = data;

        if (index !== undefined) {
          // Set current index directly
          await setCurrentIndex(userId, index);
          const queue = await getQueue(userId);
          if (queue) {
            socket.to(playerRoom).emit('track:change', { index, queue });
          }
        } else if (direction === 'next' || direction === 'previous') {
          // Get current queue
          const queue = await getQueue(userId);
          if (!queue || queue.tracks.length === 0) {
            return;
          }

          let newIndex = queue.current;
          if (direction === 'next') {
            newIndex = Math.min(queue.current + 1, queue.tracks.length - 1);
          } else if (direction === 'previous') {
            newIndex = Math.max(queue.current - 1, 0);
          }

          await setCurrentIndex(userId, newIndex);
          const updatedQueue = await getQueue(userId);
          if (updatedQueue) {
            socket.to(playerRoom).emit('track:change', { index: newIndex, queue: updatedQueue });
          }
        } else if (trackId) {
          // Find track by ID and set as current
          const queue = await getQueue(userId);
          if (!queue) {
            return;
          }

          const trackIndex = queue.tracks.findIndex(t => t.id === trackId);
          if (trackIndex >= 0) {
            await setCurrentIndex(userId, trackIndex);
            const updatedQueue = await getQueue(userId);
            if (updatedQueue) {
              socket.to(playerRoom).emit('track:change', { index: trackIndex, queue: updatedQueue });
            }
          }
        }
      } catch (error) {
        logger.error(`Error handling track:change:`, error);
      }
    });

    /**
     * Handle seek requests
     * Broadcast to all user's devices
     */
    socket.on('seek', async (data: { position: number }) => {
      try {
        const { position } = data;
        // Broadcast seek to all user's devices (excluding sender)
        socket.to(playerRoom).emit('seek', { position });
        logger.debug(`Broadcasted seek request for user ${userId}: ${position}s`);
      } catch (error) {
        logger.error(`Error handling seek:`, error);
      }
    });

    /**
     * Handle errors
     */
    socket.on('error', (error: Error) => {
      logger.error(`Player socket error for user ${userId}:`, error.message);
    });

    /**
     * Handle disconnect
     */
    socket.on('disconnect', (reason: string) => {
      logger.info(`Client disconnected from player namespace: ${socket.id} (user: ${userId}, reason: ${reason})`);
      socket.leave(playerRoom);
    });
  });

  return playerNamespace;
};






