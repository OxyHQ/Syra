import { Server as SocketIOServer, Socket } from 'socket.io';
import { logger } from '../utils/logger';
import { Track, PlaylistTrack } from '@syra/shared-types';
import { oxy } from '../../server';

export const setupPlaylistSocket = (io: SocketIOServer) => {
  const playlistNamespace = io.of('/playlists');

  playlistNamespace.use(oxy.authSocket());

  playlistNamespace.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string | undefined;

    if (!userId) {
      socket.disconnect();
      return;
    }

    logger.info('Client connected to playlist namespace', { socketId: socket.id, userId });

    socket.on('join:playlist', (playlistId: string) => {
      if (!playlistId || typeof playlistId !== 'string') return;
      socket.join(`playlist:${playlistId}`);
    });

    socket.on('leave:playlist', (playlistId: string) => {
      if (!playlistId || typeof playlistId !== 'string') return;
      socket.leave(`playlist:${playlistId}`);
    });

    socket.on('playlist:track:added', (data: { playlistId: string; tracks: Track[]; playlistTracks: PlaylistTrack[] }) => {
      try {
        const { playlistId, tracks, playlistTracks } = data;
        if (!playlistId) return;
        socket.to(`playlist:${playlistId}`).emit('playlist:track:added', { playlistId, tracks, playlistTracks });
      } catch (error) {
        logger.error('Error handling playlist:track:added', { err: error });
      }
    });

    socket.on('playlist:track:removed', (data: { playlistId: string; trackIds: string[] }) => {
      try {
        const { playlistId, trackIds } = data;
        if (!playlistId) return;
        socket.to(`playlist:${playlistId}`).emit('playlist:track:removed', { playlistId, trackIds });
      } catch (error) {
        logger.error('Error handling playlist:track:removed', { err: error });
      }
    });

    socket.on('playlist:track:reordered', (data: { playlistId: string; trackIds: string[] }) => {
      try {
        const { playlistId, trackIds } = data;
        if (!playlistId) return;
        socket.to(`playlist:${playlistId}`).emit('playlist:track:reordered', { playlistId, trackIds });
      } catch (error) {
        logger.error('Error handling playlist:track:reordered', { err: error });
      }
    });

    socket.on('playlist:updated', (data: { playlistId: string; updates: Record<string, unknown> }) => {
      try {
        const { playlistId, updates } = data;
        if (!playlistId) return;
        socket.to(`playlist:${playlistId}`).emit('playlist:updated', { playlistId, updates });
      } catch (error) {
        logger.error('Error handling playlist:updated', { err: error });
      }
    });

    socket.on('error', (error: Error) => {
      logger.error('Playlist socket error', { err: error, userId });
    });

    socket.on('disconnect', (reason: string) => {
      logger.info('Client disconnected from playlist namespace', { socketId: socket.id, userId, reason });
    });
  });

  return playlistNamespace;
};
