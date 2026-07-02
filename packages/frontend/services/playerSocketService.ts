import { API_URL_SOCKET } from '@/config';
import { io, Socket } from 'socket.io-client';
import { ConnectPlaybackState, Queue, Device, DeviceType, PlaybackCommand } from '@syra/shared-types';
import { usePlayerStore } from '../stores/playerStore';
import { useQueueStore } from '../stores/queueStore';

/** Descriptor sent to the server to (re)register this device. */
interface DeviceRegistration {
  deviceId: string;
  name: string;
  type: DeviceType;
  capabilities: string[];
}

class PlayerSocketService {
  private socket: Socket | null = null;
  private isConnected = false;
  private currentUserId?: string;
  /** Last device descriptor registered, re-sent automatically after reconnects. */
  private lastDeviceRegistration?: DeviceRegistration;
  /**
   * Device-list subscribers, kept independent of the socket instance so a
   * subscription survives socket (re)creation and works even if registered
   * before the socket connects. A single fan-out handler (attached in
   * setupEventListeners) forwards each `device:list` event to all of them.
   */
  private deviceListCallbacks = new Set<(devices: Device[]) => void>();
  /**
   * This device's stable id (set once presence is registered). Lets the store
   * decide whether an incoming `activeDeviceId` refers to THIS device — i.e.
   * whether a Syra Connect transfer targeted us and we must start playing.
   */
  private localDeviceId: string | null = null;

  /** Remember this device's id so remote playback state can be routed correctly. */
  setLocalDeviceId(deviceId: string): void {
    this.localDeviceId = deviceId;
  }

  /**
   * Connect to the player socket namespace.
   *
   * `getToken` is resolved lazily via a socket.io auth callback so a fresh
   * access token is sent on every (re)connection — reconnects after a token
   * refresh authenticate with the current token rather than a stale one.
   */
  connect(userId?: string, getToken?: () => string | null | undefined) {
    // Switching users → fully tear down the previous session first.
    if (userId && this.currentUserId && userId !== this.currentUserId) {
      this.disconnect();
    }

    if (this.socket?.connected) {
      return;
    }

    try {
      if (userId) this.currentUserId = userId;

      // Clean up a stale, non-connected socket before creating a new one.
      if (this.socket) {
        this.socket.disconnect();
        this.socket = null;
      }

      // Connect to player namespace
      this.socket = io(`${API_URL_SOCKET}/player`, {
        transports: ['websocket', 'polling'],
        auth: (cb) => cb({ token: getToken?.() ?? undefined }),
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
      this.isConnected = true;

      // Join the per-user player room.
      this.socket?.emit('join:player');

      // Re-register this device on every (re)connect so the server-side
      // socket↔device binding is restored after a reconnect, not just on the
      // first connect.
      if (this.lastDeviceRegistration) {
        this.socket?.emit('device:register', this.lastDeviceRegistration);
      }
    });

    this.socket.on('disconnect', () => {
      this.isConnected = false;
    });

    // Single fan-out for the device list → forward to every subscriber. Bound
    // once per socket; subscribers live on the service, not the socket.
    this.socket.on('device:list', (list: Device[]) => {
      this.deviceListCallbacks.forEach((cb) => cb(list));
    });

    this.socket.on('connect_error', (error) => {
      console.error('[PlayerSocket] Connection error:', error);
    });

    // Server-authoritative playback state (device transfers, remote play/pause,
    // progress from the active device). The store decides what to do based on
    // whether THIS device is the active playback target.
    this.socket.on('playback:state', (update: ConnectPlaybackState) => {
      void usePlayerStore.getState().applyRemotePlaybackState(update, this.localDeviceId);
    });

    // Listen for queue updates from other devices
    this.socket.on('queue:update', (queue: Queue) => {
      const queueStore = useQueueStore.getState();
      queueStore.syncQueue(queue);
    });

    // Listen for track changes from other devices
    this.socket.on('track:change', async (data: { index: number; queue?: Queue }) => {
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
      const playerStore = usePlayerStore.getState();
      playerStore.seek(data.position);
    });
  }

  /**
   * Emit playback state update
   */
  emitPlaybackState(update: ConnectPlaybackState) {
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
   * Register this device with the server. The descriptor is cached so it can be
   * re-sent automatically after a reconnect (see the `connect` handler).
   */
  emitDeviceRegister(device: DeviceRegistration) {
    this.lastDeviceRegistration = device;
    if (this.socket?.connected) {
      this.socket.emit('device:register', device);
    }
  }

  /**
   * Ask the server to send the current device list to this socket. The backend
   * responds to the requesting socket with a `device:list` event.
   */
  requestDeviceList() {
    this.socket?.emit('device:list');
  }

  /**
   * Subscribe to the device list and invoke the callback whenever it updates.
   * Decoupled from the socket: the subscription is valid regardless of socket
   * state and survives reconnects/socket recreation. Returns an unsubscribe
   * function.
   */
  onDeviceList(callback: (devices: Device[]) => void): () => void {
    this.deviceListCallbacks.add(callback);
    return () => {
      this.deviceListCallbacks.delete(callback);
    };
  }

  /**
   * Emit a playback command (play/pause/seek/transfer/volume/etc.).
   */
  emitPlaybackCommand(command: PlaybackCommand) {
    if (this.socket?.connected) {
      this.socket.emit('playback:command', command);
    }
  }

  /**
   * Emit a heartbeat to signal this device is still alive.
   */
  emitHeartbeat(deviceId: string) {
    if (this.socket?.connected) {
      this.socket.emit('heartbeat', { deviceId });
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






