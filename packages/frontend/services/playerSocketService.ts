import { API_URL_SOCKET } from '@/config';
import { io, Socket } from 'socket.io-client';
import { PlaybackStateUpdate, Queue, PlaybackState } from '@syra/shared-types';
import { usePlayerStore } from '../stores/playerStore';
import { useQueueStore } from '../stores/queueStore';

class PlayerSocketService {
  private socket: Socket | null = null;
  private isConnected = false;
  private currentUserId?: string;

  /**
   * Connect to player socket namespace
   */
  connect(userId?: string, token?: string) {
    if (this.socket?.connected) {
      console.log('[PlayerSocket] Already connected');
      return;
    }

    try {
      if (userId) this.currentUserId = userId;

      // Connect to player namespace
      this.socket = io(`${API_URL_SOCKET}/player`, {
        transports: ['websocket', 'polling'],
        auth: token ? { token, userId } : (userId ? { userId } : undefined),
        autoConnect: true,
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
      });

      this.setupEventListeners();
    } catch (error) {
      console.error('[PlayerSocket] Error connecting:', error);
    }
  }

  /**
   * Setup socket event listeners
   */
  private setupEventListeners() {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      console.log('[PlayerSocket] Connected');
      this.isConnected = true;

      // Join player room
      if (this.currentUserId) {
        this.socket?.emit('join:player');
      }
    });

    this.socket.on('disconnect', () => {
      console.log('[PlayerSocket] Disconnected');
      this.isConnected = false;
    });

    this.socket.on('connect_error', (error) => {
      console.error('[PlayerSocket] Connection error:', error);
    });

    // Listen for playback state updates from other devices
    this.socket.on('playback:state', (update: PlaybackStateUpdate) => {
      console.log('[PlayerSocket] Received playback state update:', update);
      const playerStore = usePlayerStore.getState();

      if (update.state === PlaybackState.PLAYING) {
        playerStore.resume();
      } else if (update.state === PlaybackState.PAUSED) {
        playerStore.pause();
      }

      if (update.position) {
        playerStore.seek(update.position.currentTime);
      }

      if (update.volume !== undefined) {
        playerStore.setVolume(update.volume);
      }
    });

    // Listen for queue updates from other devices
    this.socket.on('queue:update', (queue: Queue) => {
      console.log('[PlayerSocket] Received queue update:', queue);
      const queueStore = useQueueStore.getState();
      queueStore.syncQueue(queue);
    });

    // Listen for track changes from other devices
    this.socket.on('track:change', async (data: { index: number; queue?: Queue }) => {
      console.log('[PlayerSocket] Received track change:', data);
      const { index, queue } = data;

      if (queue) {
        const queueStore = useQueueStore.getState();
        queueStore.syncQueue(queue);
      }

      const playerStore = usePlayerStore.getState();
      await playerStore.playFromQueue(index);
    });

    // Listen for seek requests from other devices
    this.socket.on('seek', (data: { position: number }) => {
      console.log('[PlayerSocket] Received seek request:', data);
      const playerStore = usePlayerStore.getState();
      playerStore.seek(data.position);
    });
  }

  /**
   * Emit playback state update
   */
  emitPlaybackState(update: PlaybackStateUpdate) {
    if (this.socket?.connected) {
      this.socket.emit('playback:state', update);
    }
  }

  /**
   * Emit queue update
   */
  emitQueueUpdate(queue: Queue) {
    if (this.socket?.connected) {
      this.socket.emit('queue:update', queue);
    }
  }

  /**
   * Emit track change
   */
  emitTrackChange(data: { trackId?: string; index?: number; direction?: 'next' | 'previous' }) {
    if (this.socket?.connected) {
      this.socket.emit('track:change', data);
    }
  }

  /**
   * Emit seek request
   */
  emitSeek(position: number) {
    if (this.socket?.connected) {
      this.socket.emit('seek', { position });
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
export const playerSocketService = new PlayerSocketService();






