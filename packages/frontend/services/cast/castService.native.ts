/**
 * Native cast service — `react-native-google-cast` (iOS/Android).
 *
 * Wraps `RemoteMediaClient` in a {@link PlayerEngine} so the player store can
 * drive a Chromecast exactly like the local AVPlayer/ExoPlayer engine. Session
 * lifecycle is tracked through `SessionManager`, and cast state through
 * `CastContext.onCastStateChanged`.
 *
 * This is the ONLY cast variant that imports `react-native-google-cast` — the
 * clean default (`castService.ts`) and web variant (`castService.web.ts`) must
 * never import it (platform-split rule). Requires a custom dev/prod build with
 * the `react-native-google-cast` config plugin; it does NOT run in Expo Go.
 */

import {
  CastContext,
  CastState,
  MediaPlayerIdleReason,
  MediaPlayerState,
  MediaStreamType,
} from 'react-native-google-cast';
import type {
  CastSession,
  Device,
  MediaInfo,
  MediaStatus,
  RemoteMediaClient,
} from 'react-native-google-cast';
import type { PlayerEngine, PlaybackStatusUpdate } from '@/stores/playback/playerEngine';
import { createScopedLogger } from '@/utils/logger';
import { CAST_HLS_CONTENT_TYPE } from './types';
import type { CastController, CastMediaMetadata, CastSessionState } from './types';

const logger = createScopedLogger('CastNative');

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Subscription {
  remove(): void;
}

function mapCastState(raw: CastState | null): CastSessionState {
  switch (raw) {
    case CastState.CONNECTED:
      return 'connected';
    case CastState.CONNECTING:
      return 'connecting';
    case CastState.NOT_CONNECTED:
      return 'available';
    default:
      return 'no_devices';
  }
}

// ── Engine ────────────────────────────────────────────────────────────────────

class NativeCastEngine implements PlayerEngine {
  private readonly listeners: Array<(status: PlaybackStatusUpdate) => void> = [];
  private readonly subscriptions: Subscription[] = [];
  private playerState: MediaPlayerState | null = null;
  private idleReason: MediaPlayerIdleReason | null = null;
  private cachedCurrentTime = 0;
  private cachedDuration = 0;
  private cachedVolume = 1;
  private destroyed = false;

  constructor(
    private readonly client: RemoteMediaClient,
    private readonly getMeta: () => CastMediaMetadata,
    private readonly onRemoved: () => void,
  ) {
    this.subscriptions.push(
      this.client.onMediaStatusUpdated((status) => this.handleStatus(status)),
      this.client.onMediaProgressUpdated((progress, duration) => {
        this.cachedCurrentTime = progress;
        this.cachedDuration = duration;
        this.emit(false);
      }),
    );
  }

  // ── PlayerEngine properties ────────────────────────────────────────────────

  get playing(): boolean {
    return this.playerState === MediaPlayerState.PLAYING;
  }

  get isLoaded(): boolean {
    return (
      this.playerState === MediaPlayerState.PLAYING ||
      this.playerState === MediaPlayerState.PAUSED ||
      this.playerState === MediaPlayerState.BUFFERING
    );
  }

  get currentTime(): number {
    return this.cachedCurrentTime;
  }

  get duration(): number {
    return this.cachedDuration;
  }

  get volume(): number {
    return this.cachedVolume;
  }

  set volume(value: number) {
    this.cachedVolume = value;
    this.client.setStreamVolume(value).catch((error: unknown) => {
      logger.warn('Cast setStreamVolume failed', { error });
    });
  }

  // ── PlayerEngine methods ───────────────────────────────────────────────────

  play(): void {
    this.client.play().catch((error: unknown) => {
      logger.warn('Cast play failed', { error });
    });
  }

  pause(): void {
    this.client.pause().catch((error: unknown) => {
      logger.warn('Cast pause failed', { error });
    });
  }

  setPlaybackRate(rate: number): void {
    this.client.setPlaybackRate(rate).catch((error: unknown) => {
      logger.warn('Cast setPlaybackRate failed', { error });
    });
  }

  async seekTo(seconds: number): Promise<void> {
    await this.client.seek({ position: seconds });
  }

  replace(source: { uri?: string }): void {
    const uri = source.uri;
    if (!uri) return;

    this.client.loadMedia({ autoplay: true, mediaInfo: this.buildMediaInfo(uri) }).catch(
      (error: unknown) => {
        logger.warn('Cast loadMedia failed', { error });
      },
    );
  }

  addListener(event: 'playbackStatusUpdate', callback: (status: PlaybackStatusUpdate) => void): void {
    if (event === 'playbackStatusUpdate') {
      this.listeners.push(callback);
    }
  }

  remove(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const subscription of this.subscriptions) {
      subscription.remove();
    }
    this.subscriptions.length = 0;
    this.listeners.length = 0;
    // Release the controller's reference so the next getEngine() rebinds a live
    // engine to the (still-adopted) session. This never ends the cast session.
    this.onRemoved();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private buildMediaInfo(uri: string): MediaInfo {
    const meta = this.getMeta();
    return {
      contentUrl: uri,
      contentType: CAST_HLS_CONTENT_TYPE,
      streamType: MediaStreamType.BUFFERED,
      metadata: {
        type: 'musicTrack',
        title: meta.title,
        artist: meta.subtitle,
        images: meta.artworkUrl ? [{ url: meta.artworkUrl }] : undefined,
      },
    };
  }

  private handleStatus(status: MediaStatus | null): void {
    if (this.destroyed) return;

    this.playerState = status?.playerState ?? null;
    this.idleReason = status?.idleReason ?? null;
    if (typeof status?.volume === 'number') {
      this.cachedVolume = status.volume;
    }
    if (typeof status?.streamPosition === 'number' && this.cachedCurrentTime === 0) {
      this.cachedCurrentTime = status.streamPosition;
    }

    const didJustFinish =
      this.playerState === MediaPlayerState.IDLE &&
      this.idleReason === MediaPlayerIdleReason.FINISHED;
    this.emit(didJustFinish);
  }

  private emit(didJustFinish: boolean): void {
    const update: PlaybackStatusUpdate = {
      isLoaded: this.isLoaded,
      playing: this.playing,
      currentTime: this.currentTime,
      duration: this.duration,
      didJustFinish,
    };
    for (const cb of this.listeners) {
      cb(update);
    }
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

class NativeCastController implements CastController {
  private readonly subscribers = new Set<(state: CastSessionState) => void>();
  private castState: CastState | null = null;
  private client: RemoteMediaClient | null = null;
  private engine: NativeCastEngine | null = null;
  private deviceName: string | null = null;
  private meta: CastMediaMetadata = {};

  constructor() {
    CastContext.onCastStateChanged((state) => {
      this.castState = state;
      this.notifySubscribers();
    });
    void CastContext.getCastState().then((state) => {
      this.castState = state;
      this.notifySubscribers();
    });

    const sessionManager = CastContext.getSessionManager();
    sessionManager.onSessionStarted((session) => this.adoptSession(session));
    sessionManager.onSessionResumed((session) => this.adoptSession(session));
    sessionManager.onSessionEnded(() => this.releaseSession());
    void sessionManager.getCurrentCastSession().then((session) => {
      if (session) this.adoptSession(session);
    });
  }

  isSupported(): boolean {
    return true;
  }

  getSessionState(): CastSessionState {
    return mapCastState(this.castState);
  }

  onSessionStateChange(cb: (state: CastSessionState) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  async requestSession(): Promise<void> {
    await CastContext.showCastDialog();
  }

  async endSession(): Promise<void> {
    await CastContext.getSessionManager().endCurrentSession(true);
  }

  getDeviceName(): string | null {
    return this.deviceName;
  }

  getEngine(): PlayerEngine | null {
    if (!this.engine && this.client) {
      this.engine = this.createEngine(this.client);
    }
    return this.engine;
  }

  setMediaMetadata(meta: CastMediaMetadata): void {
    this.meta = meta;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private adoptSession(session: CastSession): void {
    this.releaseSession();
    const client = session.getClient();
    this.client = client;
    this.engine = this.createEngine(client);
    void session
      .getCastDevice()
      .then((device: Device | null) => {
        this.deviceName = device?.friendlyName ?? null;
        this.notifySubscribers();
      })
      .catch((error: unknown) => {
        logger.warn('Failed to read cast device name', { error });
      });
    this.notifySubscribers();
  }

  private createEngine(client: RemoteMediaClient): NativeCastEngine {
    return new NativeCastEngine(client, () => this.meta, () => {
      this.engine = null;
    });
  }

  private releaseSession(): void {
    this.engine?.remove();
    this.engine = null;
    this.client = null;
    this.deviceName = null;
  }

  private notifySubscribers(): void {
    const state = this.getSessionState();
    for (const cb of this.subscribers) {
      cb(state);
    }
  }
}

export const castController: CastController = new NativeCastController();
