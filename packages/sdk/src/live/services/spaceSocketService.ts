import { io, type Socket } from 'socket.io-client';
import type { OxyServices } from '@oxy.so/core';

interface SessionConnection {
  oxy: OxyServices;
  epoch: number;
  socket: Socket;
  controller: AbortController;
  linked: ReturnType<OxyServices['createLinkedClient']>;
  unsubscribe: () => void;
  leases: Map<object, () => void>;
}
import type {
  RoomParticipant,
  ParticipantsUpdateData,
  MuteUpdateData,
  SpeakerRequestData,
} from '../types';

type SimpleRoomCallback = (data: { roomId: string; timestamp?: string }) => void;

export class RoomSocketService {
  private socket: Socket | null = null;
  private _isConnected = false;
  private socketUrl: string;
  private sessionConnection?: SessionConnection;
  private externalIdentity?: { userId: string; token?: string };

  constructor(socketUrl: string) {
    this.socketUrl = socketUrl;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  /** Explicit credential API for external consumers; own apps use connectWithOxy. */
  connect(userId: string, token?: string): void {
    if (
      this.socket?.active &&
      !this.sessionConnection &&
      this.externalIdentity?.userId === userId &&
      this.externalIdentity.token === token
    )
      return;
    this.disconnect();
    this.externalIdentity = { userId, token };
    this.openSocket({ token, userId });
  }

  /** Acquire one lease on this account's shared session connection (Oxy core >=7.1). */
  connectWithOxy(oxy: OxyServices, onContextEnd: () => void = () => {}): () => void {
    const epoch = oxy.http.getSessionEpoch();
    let connection = this.sessionConnection;
    if (!connection || connection.oxy !== oxy || connection.epoch !== epoch) {
      this.disconnect();
      const target = `${this.socketUrl || 'ws://localhost:4120'}/rooms`;
      const base = new URL(target);
      base.protocol =
        base.protocol === 'wss:' ? 'https:' : base.protocol === 'ws:' ? 'http:' : base.protocol;
      const linked = oxy.createLinkedClient({ baseURL: base.origin });
      const controller = new AbortController();
      const socket = this.openSocket((callback) => {
        void linked.getAccessToken(target, { signal: controller.signal }).then(
          (token) => {
            if (!controller.signal.aborted) callback({ token });
          },
          () => {
            if (!controller.signal.aborted) callback({});
          },
        );
      }, false);
      connection = {
        oxy,
        epoch,
        socket,
        linked,
        controller,
        unsubscribe: () => {},
        leases: new Map(),
      };
      this.sessionConnection = connection;
      const current = connection;
      connection.unsubscribe = oxy.http.addTokenChangeListener(() => {
        if (oxy.http.getSessionEpoch() === epoch || this.sessionConnection !== current) return;
        const callbacks = [...current.leases.values()];
        this.disconnect();
        for (const callback of callbacks) callback();
      });
      socket.connect();
    }
    const current = connection;
    const lease = {};
    current.leases.set(lease, onContextEnd);
    return () => {
      current.leases.delete(lease);
      if (this.sessionConnection === current && current.leases.size === 0) this.disconnect();
    };
  }

  private openSocket(
    auth: { token?: string; userId?: string } | ((callback: (data: object) => void) => void),
    autoConnect = true,
  ): Socket {
    const socket = io(`${this.socketUrl || 'ws://localhost:4120'}/rooms`, {
      transports: ['websocket', 'polling'],
      auth,
      autoConnect,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });
    this.socket = socket;
    socket.on('connect', () => {
      if (this.socket === socket) this._isConnected = true;
    });
    socket.on('disconnect', () => {
      if (this.socket === socket) this._isConnected = false;
    });
    socket.on('connect_error', (err) => {
      console.warn('Room socket connect error:', err.message);
    });
    return socket;
  }

  disconnect(): void {
    const connection = this.sessionConnection;
    this.sessionConnection = undefined;
    this.externalIdentity = undefined;
    connection?.controller.abort();
    connection?.unsubscribe();
    connection?.linked.dispose();
    connection?.leases.clear();
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this._isConnected = false;
  }

  joinRoom(
    roomId: string,
    callback?: (res: {
      success: boolean;
      participants?: RoomParticipant[];
      myRole?: string;
      error?: string;
    }) => void,
  ): void {
    this.socket?.emit('room:join', { roomId }, callback);
  }

  leaveRoom(roomId: string): void {
    this.socket?.emit('room:leave', { roomId });
  }
  setMute(roomId: string, isMuted: boolean): void {
    this.socket?.emit('audio:mute', { roomId, isMuted });
  }
  requestToSpeak(roomId: string): void {
    this.socket?.emit('speaker:request', { roomId });
  }
  approveSpeaker(roomId: string, targetUserId: string): void {
    this.socket?.emit('speaker:approve', { roomId, targetUserId });
  }
  denySpeaker(roomId: string, targetUserId: string): void {
    this.socket?.emit('speaker:deny', { roomId, targetUserId });
  }
  removeSpeaker(roomId: string, targetUserId: string): void {
    this.socket?.emit('speaker:remove', { roomId, targetUserId });
  }

  onParticipantsUpdate(cb: (data: ParticipantsUpdateData) => void): () => void {
    const socket = this.socket;
    socket?.on('room:participants:update', cb);
    return () => {
      socket?.off('room:participants:update', cb);
    };
  }

  onParticipantMute(cb: (data: MuteUpdateData) => void): () => void {
    const socket = this.socket;
    socket?.on('room:participant:mute', cb);
    return () => {
      socket?.off('room:participant:mute', cb);
    };
  }

  onSpeakerRequestReceived(cb: (data: SpeakerRequestData) => void): () => void {
    const socket = this.socket;
    socket?.on('speaker:request:received', cb);
    return () => {
      socket?.off('speaker:request:received', cb);
    };
  }

  onSpeakerApproved(cb: SimpleRoomCallback): () => void {
    const socket = this.socket;
    socket?.on('speaker:approved', cb);
    return () => {
      socket?.off('speaker:approved', cb);
    };
  }

  onSpeakerDenied(cb: SimpleRoomCallback): () => void {
    const socket = this.socket;
    socket?.on('speaker:denied', cb);
    return () => {
      socket?.off('speaker:denied', cb);
    };
  }

  onSpeakerRemoved(cb: SimpleRoomCallback): () => void {
    const socket = this.socket;
    socket?.on('speaker:removed', cb);
    return () => {
      socket?.off('speaker:removed', cb);
    };
  }

  onRoomStarted(cb: SimpleRoomCallback): () => void {
    const socket = this.socket;
    socket?.on('room:started', cb);
    return () => {
      socket?.off('room:started', cb);
    };
  }

  onRoomEnded(cb: SimpleRoomCallback): () => void {
    const socket = this.socket;
    socket?.on('room:ended', cb);
    return () => {
      socket?.off('room:ended', cb);
    };
  }

  onUserJoined(cb: (data: { userId: string; role: string; roomId: string }) => void): () => void {
    const socket = this.socket;
    socket?.on('room:user:joined', cb);
    return () => {
      socket?.off('room:user:joined', cb);
    };
  }

  onUserLeft(cb: (data: { userId: string; roomId: string }) => void): () => void {
    const socket = this.socket;
    socket?.on('room:user:left', cb);
    return () => {
      socket?.off('room:user:left', cb);
    };
  }

  onStreamStarted(
    cb: (data: {
      roomId: string;
      title?: string;
      image?: string;
      description?: string;
      startedAt?: string;
      durationSec?: number;
      timestamp: string;
    }) => void,
  ): () => void {
    const socket = this.socket;
    socket?.on('room:stream:started', cb);
    return () => {
      socket?.off('room:stream:started', cb);
    };
  }

  onStreamStopped(cb: (data: { roomId: string; timestamp: string }) => void): () => void {
    const socket = this.socket;
    socket?.on('room:stream:stopped', cb);
    return () => {
      socket?.off('room:stream:stopped', cb);
    };
  }

  onRecordingStarted(
    cb: (data: { roomId: string; recordingId: string; timestamp: string }) => void,
  ): () => void {
    const socket = this.socket;
    socket?.on('room:recording:started', cb);
    return () => {
      socket?.off('room:recording:started', cb);
    };
  }

  onRecordingStopped(
    cb: (data: {
      roomId: string;
      recordingId?: string;
      reason?: string;
      timestamp: string;
    }) => void,
  ): () => void {
    const socket = this.socket;
    socket?.on('room:recording:stopped', cb);
    return () => {
      socket?.off('room:recording:stopped', cb);
    };
  }
}
