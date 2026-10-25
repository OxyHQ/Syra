import { API_URL_SOCKET, API_URL } from '@/config';
import type { OxyServices } from '@oxy.so/core';
import { io, type Socket } from 'socket.io-client';
import type {
  ConnectPlaybackState,
  Queue,
  Device,
  DeviceType,
  PlaybackCommand,
} from '@syra/shared-types';
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
  private currentOxy?: OxyServices;
  private epoch?: number;
  private releaseSession?: () => void;
  private sessionLeases = new Map<object, () => void>();
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

  /** The app's one presence owner uses the shared session for each handshake. */
  connect(oxy: OxyServices, onContextEnd: () => void = () => {}): () => void {
    const epoch = oxy.http.getSessionEpoch();
    if (this.currentOxy === oxy && this.epoch === epoch && this.socket?.active) {
      return this.acquireLease(onContextEnd);
    }
    this.disconnect();
    const linked = oxy.createLinkedClient({ baseURL: API_URL });
    const controller = new AbortController();
    const target = `${API_URL_SOCKET}/player`;
    const current = io(target, {
      transports: ['websocket', 'polling'],
      auth: (callback) => {
        void linked.getAccessToken(target, { signal: controller.signal }).then(
          (token) => {
            if (!controller.signal.aborted) callback({ token });
          },
          () => {
            if (!controller.signal.aborted) callback({});
          },
        );
      },
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });
    this.socket = current;
    this.currentOxy = oxy;
    this.epoch = epoch;
    const unsubscribe = oxy.http.addTokenChangeListener(() => {
      if (oxy.http.getSessionEpoch() === epoch || this.socket !== current) return;
      const callbacks = [...this.sessionLeases.values()];
      this.disconnect();
      for (const callback of callbacks) callback();
    });
    this.releaseSession = () => {
      controller.abort();
      unsubscribe();
      linked.dispose();
    };
    this.setupEventListeners();
    current.connect();
    return this.acquireLease(onContextEnd);
  }

  private acquireLease(onContextEnd: () => void): () => void {
    const current = this.socket;
    const lease = {};
    this.sessionLeases.set(lease, onContextEnd);
    return () => {
      this.sessionLeases.delete(lease);
      if (this.socket === current && this.sessionLeases.size === 0) this.disconnect();
    };
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
      queueStore.syncQueue(queue, 'socket');
    });

    // Listen for track changes from other devices
    this.socket.on('track:change', async (data: { index: number; queue?: Queue }) => {
      const { index, queue } = data;

      if (queue) {
        const queueStore = useQueueStore.getState();
        queueStore.syncQueue(queue, 'socket');
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

  /** An effect release also cancels an unfinished authentication handshake. */
  releaseFromEffect() {
    this.disconnect();
  }

  disconnect() {
    this.releaseSession?.();
    this.releaseSession = undefined;
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.isConnected = false;
    this.currentOxy = undefined;
    this.epoch = undefined;
    this.lastDeviceRegistration = undefined;
    this.localDeviceId = null;
    this.sessionLeases.clear();
    for (const callback of this.deviceListCallbacks) callback([]);
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
