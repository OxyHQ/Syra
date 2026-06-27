import { Server as SocketIOServer, Socket } from 'socket.io';
import { logger } from '../utils/logger';
import { PlaybackStateUpdate, Queue, PlaybackCommand } from '@syra/shared-types';
import { getQueue, setCurrentIndex } from '../services/queueService';
import { registerDevice, listDevices, heartbeat } from '../services/playback/deviceService';
import { applyCommand, updateProgress, handleDeviceDisconnect } from '../services/playback/playbackStateService';
import type { DeviceType } from '@syra/shared-types';
import { oxy } from '../oxyClient';

export const setupPlayerSocket = (io: SocketIOServer) => {
  const playerNamespace = io.of('/player');

  playerNamespace.use(oxy.authSocket());

  playerNamespace.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string | undefined;

    if (!userId) {
      socket.disconnect();
      return;
    }

    logger.info('Client connected to player namespace', { socketId: socket.id, userId });

    const playerRoom = `player:${userId}`;
    socket.join(playerRoom);

    let socketDeviceId: string | undefined;

    socket.on('join:player', () => {
      socket.join(playerRoom);
    });

    socket.on('device:register', async (input: { deviceId: string; name: string; type: DeviceType; capabilities?: string[] }) => {
      try {
        if (!input.deviceId || !input.name || !input.type) return;
        await registerDevice(userId, input);
        socketDeviceId = input.deviceId;
        playerNamespace.to(playerRoom).emit('device:list', await listDevices(userId));
      } catch (error) {
        logger.error('Error handling device:register', { err: error, userId });
      }
    });

    socket.on('device:list', async () => {
      try {
        socket.emit('device:list', await listDevices(userId));
      } catch (error) {
        logger.error('Error handling device:list', { err: error, userId });
      }
    });

    socket.on('playback:command', async (command: PlaybackCommand) => {
      try {
        const state = await applyCommand(userId, command);
        playerNamespace.to(playerRoom).emit('playback:state', state);
      } catch (error) {
        logger.error('Error handling playback:command', { err: error, userId });
      }
    });

    socket.on('playback:progress', async (data: { positionMs: number; isPlaying?: boolean }) => {
      try {
        if (!socketDeviceId) return;
        const state = await updateProgress(userId, socketDeviceId, data.positionMs, data.isPlaying);
        socket.to(playerRoom).emit('playback:state', state);
      } catch (error) {
        logger.error('Error handling playback:progress', { err: error, userId });
      }
    });

    socket.on('heartbeat', async () => {
      try {
        if (socketDeviceId) await heartbeat(userId, socketDeviceId);
      } catch (error) {
        logger.error('Error handling heartbeat', { err: error, userId });
      }
    });

    socket.on('playback:state', async (update: PlaybackStateUpdate) => {
      try {
        socket.to(playerRoom).emit('playback:state', update);
      } catch (error) {
        logger.error('Error handling playback:state', { err: error });
      }
    });

    socket.on('queue:update', async (queue: Queue) => {
      try {
        socket.to(playerRoom).emit('queue:update', queue);
      } catch (error) {
        logger.error('Error handling queue:update', { err: error });
      }
    });

    socket.on('track:change', async (data: { trackId?: string; index?: number; direction?: 'next' | 'previous' }) => {
      try {
        const { trackId, index, direction } = data;

        if (index !== undefined) {
          await setCurrentIndex(userId, index);
          const queue = await getQueue(userId);
          if (queue) {
            socket.to(playerRoom).emit('track:change', { index, queue });
          }
        } else if (direction === 'next' || direction === 'previous') {
          const queue = await getQueue(userId);
          if (!queue || queue.tracks.length === 0) return;

          let newIndex = queue.current;
          if (direction === 'next') {
            newIndex = Math.min(queue.current + 1, queue.tracks.length - 1);
          } else {
            newIndex = Math.max(queue.current - 1, 0);
          }

          await setCurrentIndex(userId, newIndex);
          const updatedQueue = await getQueue(userId);
          if (updatedQueue) {
            socket.to(playerRoom).emit('track:change', { index: newIndex, queue: updatedQueue });
          }
        } else if (trackId) {
          const queue = await getQueue(userId);
          if (!queue) return;

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
        logger.error('Error handling track:change', { err: error });
      }
    });

    socket.on('seek', async (data: { position: number }) => {
      try {
        socket.to(playerRoom).emit('seek', { position: data.position });
      } catch (error) {
        logger.error('Error handling seek', { err: error });
      }
    });

    socket.on('error', (error: Error) => {
      logger.error('Player socket error', { err: error, userId });
    });

    socket.on('disconnect', async (reason: string) => {
      logger.info('Client disconnected from player namespace', { socketId: socket.id, userId, reason });
      socket.leave(playerRoom);

      if (socketDeviceId) {
        try {
          const state = await handleDeviceDisconnect(userId, socketDeviceId);
          playerNamespace.to(playerRoom).emit('playback:state', state);
          playerNamespace.to(playerRoom).emit('device:list', await listDevices(userId));
        } catch (error) {
          logger.error('Error handling disconnect failover', { err: error, userId, deviceId: socketDeviceId });
        }
      }
    });
  });

  return playerNamespace;
};
