import { Server as SocketIOServer, Socket } from 'socket.io';
import { logger } from '../utils/logger';
import { PlaybackStateUpdate, Queue, PlaybackCommand } from '@syra/shared-types';
import { getQueue, setCurrentIndex } from '../services/queueService';
import { registerDevice, listDevices, heartbeat } from '../services/playback/deviceService';
import { applyCommand, updateProgress, handleDeviceDisconnect } from '../services/playback/playbackStateService';
import type { DeviceType } from '@syra/shared-types';

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

    // Track the deviceId associated with this socket for disconnect failover
    let socketDeviceId: string | undefined;

    /**
     * Handle join:player event (redundant but explicit)
     */
    socket.on('join:player', () => {
      socket.join(playerRoom);
      logger.debug(`Client ${socket.id} explicitly joined player room`);
    });

    // ── Connect events ────────────────────────────────────────────────────────

    /**
     * Register or update this device in the registry.
     * Broadcasts the fresh device list to all devices in the room.
     */
    socket.on('device:register', async (input: { deviceId: string; name: string; type: DeviceType; capabilities?: string[] }) => {
      try {
        if (!input.deviceId || !input.name || !input.type) {
          logger.warn(`device:register missing required fields for user ${userId}`);
          return;
        }
        await registerDevice(userId, input);
        socketDeviceId = input.deviceId;
        playerNamespace.to(playerRoom).emit('device:list', await listDevices(userId));
      } catch (error) {
        logger.error(`Error handling device:register for user ${userId}:`, error);
      }
    });

    /**
     * Respond to a device requesting the current device list.
     */
    socket.on('device:list', async () => {
      try {
        socket.emit('device:list', await listDevices(userId));
      } catch (error) {
        logger.error(`Error handling device:list for user ${userId}:`, error);
      }
    });

    /**
     * Apply a playback command and broadcast the authoritative state to ALL
     * devices in the room (including the sender) so everyone converges.
     */
    socket.on('playback:command', async (command: PlaybackCommand) => {
      try {
        const state = await applyCommand(userId, command);
        playerNamespace.to(playerRoom).emit('playback:state', state);
      } catch (error) {
        logger.error(`Error handling playback:command for user ${userId}:`, error);
      }
    });

    /**
     * Accept a position report from the active device and relay the updated
     * state to OTHER devices only (exclude sender to avoid echo loops).
     */
    socket.on('playback:progress', async (data: { positionMs: number; isPlaying?: boolean }) => {
      try {
        if (!socketDeviceId) return;
        const state = await updateProgress(userId, socketDeviceId, data.positionMs, data.isPlaying);
        socket.to(playerRoom).emit('playback:state', state);
      } catch (error) {
        logger.error(`Error handling playback:progress for user ${userId}:`, error);
      }
    });

    /**
     * Heartbeat — keeps the device marked as active in the registry.
     * Clients should send this on a regular interval (e.g. every 30s).
     */
    socket.on('heartbeat', async () => {
      try {
        if (socketDeviceId) await heartbeat(userId, socketDeviceId);
      } catch (error) {
        logger.error(`Error handling heartbeat for user ${userId}:`, error);
      }
    });

    // ── Legacy playback state broadcast ──────────────────────────────────────

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
     * Handle disconnect — run Connect failover if this was the active device,
     * then broadcast the updated state and device list to all remaining devices.
     */
    socket.on('disconnect', async (reason: string) => {
      logger.info(`Client disconnected from player namespace: ${socket.id} (user: ${userId}, reason: ${reason})`);
      socket.leave(playerRoom);

      if (socketDeviceId) {
        try {
          const state = await handleDeviceDisconnect(userId, socketDeviceId);
          playerNamespace.to(playerRoom).emit('playback:state', state);
          playerNamespace.to(playerRoom).emit('device:list', await listDevices(userId));
        } catch (error) {
          logger.error(`Error handling disconnect failover for user ${userId} device ${socketDeviceId}:`, error);
        }
      }
    });
  });

  return playerNamespace;
};






