/**
 * Web cast service — Google Cast CAF Web Sender SDK (`cast.framework`).
 *
 * Wraps the CAF `RemotePlayer` + `RemotePlayerController` in a {@link PlayerEngine}
 * so the player store can drive a Chromecast exactly like a local engine. The
 * CAF `<script>` is injected by the UI step (`+html.tsx`); this module only
 * consumes `window.cast` / `window.chrome` once they exist, reporting cast as
 * unsupported until the SDK signals readiness.
 *
 * See `cast-sender.d.ts` for the typed subset of the SDK used here.
 */

import type { PlayerEngine, PlaybackStatusUpdate } from '@/stores/playback/playerEngine';
import { createScopedLogger } from '@/utils/logger';
import { CAST_HLS_CONTENT_TYPE } from './types';
import type { CastController, CastMediaMetadata, CastSessionState } from './types';

const logger = createScopedLogger('CastWeb');

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFramework(): CafFrameworkNamespace | null {
  return typeof window !== 'undefined' ? window.cast?.framework ?? null : null;
}

function getChromeCast(): CafChromeCastNamespace | null {
  return typeof window !== 'undefined' ? window.chrome?.cast ?? null : null;
}

function mapCastState(raw: string, framework: CafFrameworkNamespace): CastSessionState {
  const states = framework.CastState;
  switch (raw) {
    case states.CONNECTED:
      return 'connected';
    case states.CONNECTING:
      return 'connecting';
    case states.NOT_CONNECTED:
      return 'available';
    default:
      return 'no_devices';
  }
}

// ── Engine ────────────────────────────────────────────────────────────────────

class WebCastEngine implements PlayerEngine {
  private readonly listeners: Array<(status: PlaybackStatusUpdate) => void> = [];
  private readonly onChange: (event: CafRemotePlayerChangedEvent) => void;
  private previousPlayerState: string | null;
  private destroyed = false;

  constructor(
    private readonly framework: CafFrameworkNamespace,
    private readonly chromeCast: CafChromeCastNamespace,
    private readonly remotePlayer: CafRemotePlayer,
    private readonly controller: CafRemotePlayerController,
    private readonly getMeta: () => CastMediaMetadata,
    private readonly onRemoved: () => void,
  ) {
    this.previousPlayerState = remotePlayer.playerState;
    this.onChange = () => this.handleChange();
    this.controller.addEventListener(this.framework.RemotePlayerEventType.ANY_CHANGE, this.onChange);
  }

  // ── PlayerEngine properties ────────────────────────────────────────────────

  get playing(): boolean {
    return this.remotePlayer.isConnected && !this.remotePlayer.isPaused;
  }

  get isLoaded(): boolean {
    const states = this.chromeCast.media.PlayerState;
    const state = this.remotePlayer.playerState;
    return state === states.PLAYING || state === states.PAUSED || state === states.BUFFERING;
  }

  get currentTime(): number {
    return this.remotePlayer.currentTime;
  }

  get duration(): number {
    const d = this.remotePlayer.duration;
    return Number.isFinite(d) ? d : 0;
  }

  get volume(): number {
    return this.remotePlayer.volumeLevel;
  }

  set volume(value: number) {
    this.remotePlayer.volumeLevel = value;
    this.controller.setVolumeLevel();
  }

  // ── PlayerEngine methods ───────────────────────────────────────────────────

  play(): void {
    if (this.remotePlayer.isPaused) {
      this.controller.playOrPause();
    }
  }

  pause(): void {
    if (!this.remotePlayer.isPaused) {
      this.controller.playOrPause();
    }
  }

  async seekTo(seconds: number): Promise<void> {
    this.remotePlayer.currentTime = seconds;
    this.controller.seek();
  }

  replace(source: { uri?: string }): void {
    const uri = source.uri;
    if (!uri) return;

    const session = this.framework.CastContext.getInstance().getCurrentSession();
    if (!session) {
      logger.warn('replace() called with no active cast session');
      return;
    }

    const mediaInfo = new this.chromeCast.media.MediaInfo(uri, CAST_HLS_CONTENT_TYPE);
    mediaInfo.metadata = this.buildMetadata();
    const request = new this.chromeCast.media.LoadRequest(mediaInfo);
    request.autoplay = true;

    session.loadMedia(request).catch((error: unknown) => {
      logger.warn('Cast loadMedia failed', { error });
    });
  }

  addListener(event: 'playbackStatusUpdate', callback: (status: PlaybackStatusUpdate) => void): void {
    if (event === 'playbackStatusUpdate') {
      this.listeners.push(callback);
    }
  }

  remove(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.controller.removeEventListener(
      this.framework.RemotePlayerEventType.ANY_CHANGE,
      this.onChange,
    );
    this.listeners.length = 0;
    // Release the controller's reference so the next getEngine() rebinds a live
    // engine to the (still-open) session. This never ends the cast session.
    this.onRemoved();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private buildMetadata(): CafGenericMediaMetadata {
    const meta = this.getMeta();
    const metadata = new this.chromeCast.media.GenericMediaMetadata();
    if (meta.title) metadata.title = meta.title;
    if (meta.subtitle) metadata.subtitle = meta.subtitle;
    if (meta.artworkUrl) metadata.images = [new this.chromeCast.Image(meta.artworkUrl)];
    return metadata;
  }

  private handleChange(): void {
    if (this.destroyed) return;

    const state = this.remotePlayer.playerState;
    const idle = this.chromeCast.media.PlayerState.IDLE;
    const wasNotIdle = this.previousPlayerState !== idle;
    const didJustFinish = wasNotIdle && state === idle && this.isFinished();
    this.previousPlayerState = state;

    this.emit(didJustFinish);
  }

  private isFinished(): boolean {
    const media = this.framework.CastContext.getInstance().getCurrentSession()?.getMediaSession();
    return media?.idleReason === this.chromeCast.media.IdleReason.FINISHED;
  }

  private emit(didJustFinish: boolean): void {
    const status: PlaybackStatusUpdate = {
      isLoaded: this.isLoaded,
      playing: this.playing,
      currentTime: this.currentTime,
      duration: this.duration,
      didJustFinish,
    };
    for (const cb of this.listeners) {
      cb(status);
    }
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

class WebCastController implements CastController {
  private readonly subscribers = new Set<(state: CastSessionState) => void>();
  private context: CafCastContext | null = null;
  private engine: WebCastEngine | null = null;
  private meta: CastMediaMetadata = {};
  private initialized = false;
  private readonly onCastStateChanged: (event: CafCastStateEvent) => void;

  constructor() {
    this.onCastStateChanged = () => this.notifySubscribers();
    // `+html.tsx` is ignored by Expo Router under `web.output: 'single'`, so the
    // CAF sender SDK must be injected at runtime rather than via a static <script>.
    this.ensureSdkScript();
    this.tryInitialize();
    this.scheduleReadinessCheck();
  }

  isSupported(): boolean {
    return getFramework() !== null && getChromeCast() !== null;
  }

  getSessionState(): CastSessionState {
    this.tryInitialize();
    const framework = getFramework();
    if (!framework || !this.context) {
      return 'no_devices';
    }
    return mapCastState(this.context.getCastState(), framework);
  }

  onSessionStateChange(cb: (state: CastSessionState) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  async requestSession(): Promise<void> {
    this.tryInitialize();
    if (!this.context) {
      throw new Error('Google Cast SDK is not ready');
    }
    await this.context.requestSession();
  }

  async endSession(): Promise<void> {
    this.context?.endCurrentSession(true);
  }

  getDeviceName(): string | null {
    const session = getFramework()?.CastContext.getInstance().getCurrentSession();
    return session?.getCastDevice()?.friendlyName ?? null;
  }

  getEngine(): PlayerEngine | null {
    if (this.getSessionState() !== 'connected') {
      return null;
    }
    return this.ensureEngine();
  }

  setMediaMetadata(meta: CastMediaMetadata): void {
    this.meta = meta;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /**
   * Inject the CAF Web Sender SDK script if it is not already present. Loading
   * it here (rather than from `+html.tsx`, which Expo Router does not apply to
   * the `output: 'single'` SPA shell) is what makes `window.cast` exist, so
   * `isSupported()` can ever become true. The readiness callback is registered
   * first so the SDK's `__onGCastApiAvailable` signal is never missed, and the
   * script is added at most once (covering a future `output: 'static'` build
   * where `+html.tsx` would already include it).
   */
  private ensureSdkScript(): void {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    if (window.cast?.framework) return;

    this.registerReadinessCallback();

    const src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    if (document.querySelector(`script[src="${src}"]`)) return;

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('error', () => {
      logger.warn('Failed to load the Google Cast sender SDK');
    });
    document.head.appendChild(script);
  }

  /** Idempotently wire the CAF context once the SDK is present. */
  private tryInitialize(): void {
    if (this.initialized) return;

    const framework = getFramework();
    const chromeCast = getChromeCast();
    if (!framework || !chromeCast) {
      this.registerReadinessCallback();
      return;
    }

    const context = framework.CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: chromeCast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chromeCast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    context.addEventListener(
      framework.CastContextEventType.CAST_STATE_CHANGED,
      this.onCastStateChanged,
    );
    this.context = context;
    this.initialized = true;
    this.notifySubscribers();
  }

  /** Chain onto the SDK readiness hook so we initialize as soon as it loads. */
  private registerReadinessCallback(): void {
    if (typeof window === 'undefined') return;
    const existing = window.__onGCastApiAvailable;
    if (existing && '__castServiceBound' in existing) return;

    const handler = (available: boolean): void => {
      if (typeof existing === 'function') existing(available);
      if (available) this.tryInitialize();
    };
    Object.defineProperty(handler, '__castServiceBound', { value: true });
    window.__onGCastApiAvailable = handler;
  }

  /** Cover the race where the SDK loaded before this module registered. */
  private scheduleReadinessCheck(): void {
    if (typeof window === 'undefined') return;
    window.setTimeout(() => this.tryInitialize(), 0);
  }

  private ensureEngine(): WebCastEngine | null {
    if (this.engine) return this.engine;

    const framework = getFramework();
    const chromeCast = getChromeCast();
    if (!framework || !chromeCast) return null;

    const remotePlayer = new framework.RemotePlayer();
    const controller = new framework.RemotePlayerController(remotePlayer);
    this.engine = new WebCastEngine(
      framework,
      chromeCast,
      remotePlayer,
      controller,
      () => this.meta,
      () => {
        this.engine = null;
      },
    );
    return this.engine;
  }

  private notifySubscribers(): void {
    const state = this.getSessionState();
    for (const cb of this.subscribers) {
      cb(state);
    }
  }
}

export const castController: CastController = new WebCastController();
