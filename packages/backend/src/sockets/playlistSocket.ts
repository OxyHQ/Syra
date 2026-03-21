import { Server as SocketIOServer, Socket } from 'socket.io';
import { logger } from '../utils/logger';
import { Track, PlaylistTrack } from '@syra/shared-types';

interface AuthenticatedSocket extends Socket {
  user?: {
    id: string;
  };
}

/**
 * Setup playlist socket namespace for real-time collaborative playlist editing
 */
export const setupPlaylistSocket = (io: SocketIOServer) => {
  const playlistNamespace = io.of('/playlists');

  // Authentication middleware
  playlistNamespace.use((socket: AuthenticatedSocket, next) => {
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

  playlistNamespace.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.user?.id;

    if (!userId) {
      logger.warn(`Playlist socket connection without userId: ${socket.id}`);
      socket.disconnect();
      return;
    }

    logger.info(`Client connected to playlist namespace: ${socket.id} (user: ${userId})`);

    /**
     * Handle join:playlist event
     * Join playlist room for real-time updates
     */
    socket.on('join:playlist', (playlistId: string) => {
      if (!playlistId || typeof playlistId !== 'string') {
        logger.warn(`Invalid playlistId in join:playlist: ${playlistId}`);
        return;
      }

      const playlistRoom = `playlist:${playlistId}`;
      socket.join(playlistRoom);
      logger.debug(`Client ${socket.id} joined playlist room: ${playlistRoom}`);
    });

    /**
     * Handle leave:playlist event
     * Leave playlist room
     */
    socket.on('leave:playlist', (playlistId: string) => {
      if (!playlistId || typeof playlistId !== 'string') {
        return;
      }

      const playlistRoom = `playlist:${playlistId}`;
      socket.leave(playlistRoom);
      logger.debug(`Client ${socket.id} left playlist room: ${playlistRoom}`);
    });

    /**
     * Handle playlist:track:added event
     * Broadcast to all clients viewing the playlist
     */
    socket.on('playlist:track:added', (data: { playlistId: string; tracks: Track[]; playlistTracks: PlaylistTrack[] }) => {
      try {
        const { playlistId, tracks, playlistTracks } = data;
        if (!playlistId) {
          return;
        }

        const playlistRoom = `playlist:${playlistId}`;
        // Broadcast to all clients in the room (excluding sender)
        socket.to(playlistRoom).emit('playlist:track:added', {
          playlistId,
          tracks,
          playlistTracks,
        });
        logger.debug(`Broadcasted track added to playlist ${playlistId}`);
      } catch (error) {
        logger.error(`Error handling playlist:track:added:`, error);
      }
    });

    /**
     * Handle playlist:track:removed event
     * Broadcast to all clients viewing the playlist
     */
    socket.on('playlist:track:removed', (data: { playlistId: string; trackIds: string[] }) => {
      try {
        const { playlistId, trackIds } = data;
        if (!playlistId) {
          return;
        }

        const playlistRoom = `playlist:${playlistId}`;
        // Broadcast to all clients in the room (excluding sender)
        socket.to(playlistRoom).emit('playlist:track:removed', {
          playlistId,
          trackIds,
        });
        logger.debug(`Broadcasted track removed from playlist ${playlistId}`);
      } catch (error) {
        logger.error(`Error handling playlist:track:removed:`, error);
      }
    });

    /**
     * Handle playlist:track:reordered event
     * Broadcast to all clients viewing the playlist
     */
    socket.on('playlist:track:reordered', (data: { playlistId: string; trackIds: string[] }) => {
      try {
        const { playlistId, trackIds } = data;
        if (!playlistId) {
          return;
        }

        const playlistRoom = `playlist:${playlistId}`;
        // Broadcast to all clients in the room (excluding sender)
        socket.to(playlistRoom).emit('playlist:track:reordered', {
          playlistId,
          trackIds,
        });
        logger.debug(`Broadcasted track reordered in playlist ${playlistId}`);
      } catch (error) {
        logger.error(`Error handling playlist:track:reordered:`, error);
      }
    });

    /**
     * Handle playlist:updated event
     * Broadcast playlist metadata changes
     */
    socket.on('playlist:updated', (data: { playlistId: string; updates: any }) => {
      try {
        const { playlistId, updates } = data;
        if (!playlistId) {
          return;
        }

        const playlistRoom = `playlist:${playlistId}`;
        // Broadcast to all clients in the room (excluding sender)
        socket.to(playlistRoom).emit('playlist:updated', {
          playlistId,
          updates,
        });
        logger.debug(`Broadcasted playlist update for ${playlistId}`);
      } catch (error) {
        logger.error(`Error handling playlist:updated:`, error);
      }
    });

    /**
     * Handle errors
     */
    socket.on('error', (error: Error) => {
      logger.error(`Playlist socket error for user ${userId}:`, error.message);
    });

    /**
     * Handle disconnect
     */
    socket.on('disconnect', (reason: string) => {
      logger.info(`Client disconnected from playlist namespace: ${socket.id} (user: ${userId}, reason: ${reason})`);
    });
  });

  return playlistNamespace;
};






