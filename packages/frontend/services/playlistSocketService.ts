import { API_URL_SOCKET } from '@/config';
import { io, Socket } from 'socket.io-client';
import { Track, PlaylistTrack, Playlist } from '@syra/shared-types';

/**
 * Editable playlist-metadata fields broadcast on `playlist:updated`. Mirrors the
 * subset of {@link Playlist} that the playlist-edit flow can mutate.
 */
export type PlaylistUpdatePayload = Partial<
  Pick<Playlist, 'name' | 'description' | 'coverArt' | 'visibility' | 'isPublic' | 'primaryColor' | 'secondaryColor'>
>;

type PlaylistUpdateCallback = (data: { playlistId: string; tracks: Track[]; playlistTracks: PlaylistTrack[] }) => void;
type PlaylistTrackRemovedCallback = (data: { playlistId: string; trackIds: string[] }) => void;
type PlaylistTrackReorderedCallback = (data: { playlistId: string; trackIds: string[] }) => void;
type PlaylistUpdatedCallback = (data: { playlistId: string; updates: PlaylistUpdatePayload }) => void;

class PlaylistSocketService {
  private socket: Socket | null = null;
  private isConnected = false;
  private currentUserId?: string;
  private joinedPlaylists: Set<string> = new Set();

  /**
   * Connect to playlist socket namespace
   */
  connect(userId?: string, token?: string) {
    if (this.socket?.connected) {
      return;
    }

    try {
      if (userId) this.currentUserId = userId;

      // Connect to playlists namespace
      this.socket = io(`${API_URL_SOCKET}/playlists`, {
        transports: ['websocket', 'polling'],
        auth: token ? { token } : undefined,
        autoConnect: true,
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
      });

      this.setupEventListeners();
    } catch (error) {
      console.error('[PlaylistSocket] Error connecting:', error);
    }
  }

  /**
   * Setup socket event listeners
   */
  private setupEventListeners() {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      this.isConnected = true;

      // Rejoin previously joined playlists
      this.joinedPlaylists.forEach(playlistId => {
        this.socket?.emit('join:playlist', playlistId);
      });
    });

    this.socket.on('disconnect', () => {
      this.isConnected = false;
    });

    this.socket.on('connect_error', (error) => {
      console.error('[PlaylistSocket] Connection error:', error);
    });
  }

  /**
   * Join playlist room for real-time updates
   */
  joinPlaylist(playlistId: string) {
    if (!this.socket?.connected) {
      console.warn('[PlaylistSocket] Cannot join playlist - not connected');
      return;
    }

    if (this.joinedPlaylists.has(playlistId)) {
      return; // Already joined
    }

    this.socket.emit('join:playlist', playlistId);
    this.joinedPlaylists.add(playlistId);
  }

  /**
   * Leave playlist room
   */
  leavePlaylist(playlistId: string) {
    if (!this.socket?.connected) {
      return;
    }

    if (!this.joinedPlaylists.has(playlistId)) {
      return; // Not joined
    }

    this.socket.emit('leave:playlist', playlistId);
    this.joinedPlaylists.delete(playlistId);
  }

  /**
   * Listen for track added events
   */
  onTrackAdded(callback: PlaylistUpdateCallback) {
    if (!this.socket) return;

    this.socket.on('playlist:track:added', callback);
  }

  /**
   * Listen for track removed events
   */
  onTrackRemoved(callback: PlaylistTrackRemovedCallback) {
    if (!this.socket) return;

    this.socket.on('playlist:track:removed', callback);
  }

  /**
   * Listen for track reordered events
   */
  onTrackReordered(callback: PlaylistTrackReorderedCallback) {
    if (!this.socket) return;

    this.socket.on('playlist:track:reordered', callback);
  }

  /**
   * Listen for playlist updated events
   */
  onPlaylistUpdated(callback: PlaylistUpdatedCallback) {
    if (!this.socket) return;

    this.socket.on('playlist:updated', callback);
  }

  /**
   * Remove event listeners
   */
  offTrackAdded(callback: PlaylistUpdateCallback) {
    if (!this.socket) return;
    this.socket.off('playlist:track:added', callback);
  }

  offTrackRemoved(callback: PlaylistTrackRemovedCallback) {
    if (!this.socket) return;
    this.socket.off('playlist:track:removed', callback);
  }

  offTrackReordered(callback: PlaylistTrackReorderedCallback) {
    if (!this.socket) return;
    this.socket.off('playlist:track:reordered', callback);
  }

  offPlaylistUpdated(callback: PlaylistUpdatedCallback) {
    if (!this.socket) return;
    this.socket.off('playlist:updated', callback);
  }

  /**
   * Emit track added event (for broadcasting to other clients)
   */
  emitTrackAdded(data: { playlistId: string; tracks: Track[]; playlistTracks: PlaylistTrack[] }) {
    if (this.socket?.connected) {
      this.socket.emit('playlist:track:added', data);
    }
  }

  /**
   * Emit track removed event (for broadcasting to other clients)
   */
  emitTrackRemoved(data: { playlistId: string; trackIds: string[] }) {
    if (this.socket?.connected) {
      this.socket.emit('playlist:track:removed', data);
    }
  }

  /**
   * Emit track reordered event (for broadcasting to other clients)
   */
  emitTrackReordered(data: { playlistId: string; trackIds: string[] }) {
    if (this.socket?.connected) {
      this.socket.emit('playlist:track:reordered', data);
    }
  }

  /**
   * Emit playlist updated event (for broadcasting to other clients)
   */
  emitPlaylistUpdated(data: { playlistId: string; updates: PlaylistUpdatePayload }) {
    if (this.socket?.connected) {
      this.socket.emit('playlist:updated', data);
    }
  }

  /**
   * Disconnect from socket
   */
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
      this.joinedPlaylists.clear();
    }
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.isConnected;
  }
}

// Export singleton instance
export const playlistSocketService = new PlaylistSocketService();






