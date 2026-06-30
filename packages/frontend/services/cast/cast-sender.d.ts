/**
 * Ambient typing for the subset of the Google Cast CAF Web Sender SDK that
 * `castService.web.ts` actually uses. Models only the members we touch so the
 * web cast engine stays fully typed with NO `as any`.
 *
 * The SDK injects `window.cast` (`cast.framework`) and `window.chrome`
 * (`chrome.cast`) once its `<script>` has loaded and signalled readiness via
 * `window.__onGCastApiAvailable`. Loading that script is the UI step's job
 * (`+html.tsx`); here we only describe the runtime shape.
 *
 * The `Caf*` helper types are declared global (not exported) so the web cast
 * service can name them without importing this ambient module.
 *
 * Reference: https://developers.google.com/cast/docs/reference/web_sender
 */

export {};

declare global {
  // ── cast.framework: RemotePlayer + controller ───────────────────────────────

  /** Reflects the receiver's player state; updated in place by the SDK. */
  interface CafRemotePlayer {
    isConnected: boolean;
    isPaused: boolean;
    isMediaLoaded: boolean;
    /** One of {@link CafMediaPlayerStateEnum} values, or null when idle/unknown. */
    playerState: string | null;
    /** Current position in seconds. */
    currentTime: number;
    /** Total duration in seconds (NaN/0 when unknown). */
    duration: number;
    /** Volume in the range [0, 1]. */
    volumeLevel: number;
  }

  /** Event delivered to `RemotePlayerController` listeners. */
  interface CafRemotePlayerChangedEvent {
    type: string;
    field: string;
    value: unknown;
  }

  /** Controls a {@link CafRemotePlayer}; mutate the player then call the matching method. */
  interface CafRemotePlayerController {
    /** Toggle play/pause on the receiver. */
    playOrPause(): void;
    /** Stop playback on the receiver. */
    stop(): void;
    /** Seek to `remotePlayer.currentTime` (set it first). */
    seek(): void;
    /** Apply `remotePlayer.volumeLevel` (set it first). */
    setVolumeLevel(): void;
    addEventListener(type: string, handler: (event: CafRemotePlayerChangedEvent) => void): void;
    removeEventListener(type: string, handler: (event: CafRemotePlayerChangedEvent) => void): void;
  }

  interface CafRemotePlayerCtor {
    new (): CafRemotePlayer;
  }

  interface CafRemotePlayerControllerCtor {
    new (player: CafRemotePlayer): CafRemotePlayerController;
  }

  // ── cast.framework: context + session ───────────────────────────────────────

  /** `chrome.cast.media.Media` subset — exposes why playback went idle. */
  interface CafMedia {
    /** One of {@link CafIdleReasonEnum} values, or null. */
    idleReason: string | null;
  }

  /** `chrome.cast.Receiver` subset — the connected cast device. */
  interface CafReceiver {
    /** Human-readable receiver name (e.g. "Living Room TV"). */
    friendlyName: string;
  }

  interface CafCastSession {
    /** Load media onto the receiver. Resolves with an error code string on failure. */
    loadMedia(request: CafLoadRequest): Promise<string | null>;
    /** The active media session, or null when nothing is loaded. */
    getMediaSession(): CafMedia | null;
    /** The receiver this session is connected to. */
    getCastDevice(): CafReceiver | null;
  }

  /** Event data for the CAST_STATE_CHANGED event. */
  interface CafCastStateEvent {
    /** One of {@link CafCastStateEnum} values. */
    castState: string;
  }

  interface CafCastContext {
    setOptions(options: { receiverApplicationId?: string; autoJoinPolicy?: string }): void;
    /** One of {@link CafCastStateEnum} values. */
    getCastState(): string;
    getCurrentSession(): CafCastSession | null;
    /** Resolve when a session is established; reject if cancelled/failed. */
    requestSession(): Promise<void>;
    endCurrentSession(stopCasting: boolean): void;
    addEventListener(type: string, handler: (event: CafCastStateEvent) => void): void;
    removeEventListener(type: string, handler: (event: CafCastStateEvent) => void): void;
  }

  /** Cast state values (web sender). */
  interface CafCastStateEnum {
    NO_DEVICES_AVAILABLE: string;
    NOT_CONNECTED: string;
    CONNECTING: string;
    CONNECTED: string;
  }

  interface CafCastContextEventTypeEnum {
    CAST_STATE_CHANGED: string;
  }

  interface CafRemotePlayerEventTypeEnum {
    ANY_CHANGE: string;
  }

  interface CafMediaPlayerStateEnum {
    IDLE: string;
    PLAYING: string;
    PAUSED: string;
    BUFFERING: string;
  }

  interface CafIdleReasonEnum {
    FINISHED: string;
  }

  interface CafFrameworkNamespace {
    CastContext: { getInstance(): CafCastContext };
    RemotePlayer: CafRemotePlayerCtor;
    RemotePlayerController: CafRemotePlayerControllerCtor;
    CastState: CafCastStateEnum;
    CastContextEventType: CafCastContextEventTypeEnum;
    RemotePlayerEventType: CafRemotePlayerEventTypeEnum;
  }

  // ── chrome.cast.media: load-request building blocks ─────────────────────────

  /** `chrome.cast.Image` — receiver artwork. */
  interface CafImage {
    url: string;
  }

  interface CafImageCtor {
    new (url: string): CafImage;
  }

  /** `chrome.cast.media.GenericMediaMetadata`. */
  interface CafGenericMediaMetadata {
    title?: string;
    subtitle?: string;
    images?: CafImage[];
  }

  interface CafGenericMediaMetadataCtor {
    new (): CafGenericMediaMetadata;
  }

  /** `chrome.cast.media.MediaInfo`. */
  interface CafMediaInfo {
    contentId: string;
    contentType: string;
    metadata?: CafGenericMediaMetadata;
    streamType?: string;
  }

  interface CafMediaInfoCtor {
    new (contentId: string, contentType: string): CafMediaInfo;
  }

  /** `chrome.cast.media.LoadRequest`. */
  interface CafLoadRequest {
    autoplay: boolean;
    currentTime?: number;
  }

  interface CafLoadRequestCtor {
    new (mediaInfo: CafMediaInfo): CafLoadRequest;
  }

  interface CafMediaNamespace {
    MediaInfo: CafMediaInfoCtor;
    LoadRequest: CafLoadRequestCtor;
    GenericMediaMetadata: CafGenericMediaMetadataCtor;
    PlayerState: CafMediaPlayerStateEnum;
    IdleReason: CafIdleReasonEnum;
    DEFAULT_MEDIA_RECEIVER_APP_ID: string;
  }

  interface CafAutoJoinPolicyEnum {
    ORIGIN_SCOPED: string;
  }

  interface CafChromeCastNamespace {
    media: CafMediaNamespace;
    Image: CafImageCtor;
    AutoJoinPolicy: CafAutoJoinPolicyEnum;
  }

  // ── window augmentation ─────────────────────────────────────────────────────

  interface Window {
    /** Invoked by the CAF sender script once the API is ready. */
    __onGCastApiAvailable?: (available: boolean) => void;
    cast?: { framework: CafFrameworkNamespace };
    chrome?: { cast: CafChromeCastNamespace };
  }
}
