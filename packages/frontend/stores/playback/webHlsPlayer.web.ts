/**
 * Web-only HLS playback engine for Chrome/Firefox.
 *
 * Wraps a raw HTMLAudioElement + hls.js and exposes the minimal PlayerEngine
 * surface that playerStore.ts actually consumes. Safari and native platforms
 * NEVER reach this file (Metro resolves .web.ts only on web; Safari uses the
 * 'native' path via canPlayHlsNatively).
 *
 * hls.js handles EXT-X-KEY fetching automatically — the AES-128 key URL is
 * embedded in the playlist, and the token is in the master URL itself, so no
 * extra key-loader callback is needed.
 */

import Hls from 'hls.js';
import type { PlayerEngine, PlaybackStatusUpdate } from './playerEngine';
import { createScopedLogger } from '@/utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Dependency injection — allows unit tests to inject fake constructors. */
export interface WebHlsPlayerDeps {
  AudioCtor: typeof Audio;
  HlsCtor: typeof Hls;
}

// ── Implementation ────────────────────────────────────────────────────────────

const logger = createScopedLogger('WebHlsPlayer');

function getErrorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return undefined;
  }

  const namedError = error as { name?: unknown };
  return typeof namedError.name === 'string' ? namedError.name : undefined;
}

class WebHlsPlayerImpl implements PlayerEngine {
  private readonly audio: HTMLAudioElement;
  private hls: Hls;
  private listeners: Array<(status: PlaybackStatusUpdate) => void> = [];
  private destroyed = false;

  constructor(url: string, deps: WebHlsPlayerDeps) {
    this.audio = new deps.AudioCtor();
    this.hls = new deps.HlsCtor();
    this.hls.loadSource(url);
    this.hls.attachMedia(this.audio);
    this.wireAudioEvents();
  }

  // ── PlayerEngine properties ────────────────────────────────────────────────

  get playing(): boolean {
    return !this.audio.paused;
  }

  get isLoaded(): boolean {
    // readyState >= HAVE_CURRENT_DATA (2) means enough data to play at position
    return this.audio.readyState >= 2;
  }

  get currentTime(): number {
    return this.audio.currentTime;
  }

  get duration(): number {
    const d = this.audio.duration;
    return Number.isFinite(d) ? d : 0;
  }

  get volume(): number {
    return this.audio.volume;
  }

  set volume(value: number) {
    this.audio.volume = value;
  }

  // ── PlayerEngine methods ───────────────────────────────────────────────────

  play(): void {
    void this.audio.play().catch((error: unknown) => {
      if (this.destroyed || getErrorName(error) === 'AbortError') {
        return;
      }

      logger.warn('HTML audio play request failed', { error });
      this.emit({ isLoaded: false, playing: false });
    });
  }

  pause(): void {
    this.audio.pause();
  }

  async seekTo(seconds: number): Promise<void> {
    this.audio.currentTime = seconds;
  }

  replace(source: { uri?: string }): void {
    const uri = source.uri;
    if (!uri) return;
    this.hls.loadSource(uri);
    // hls.js re-attaches automatically after loadSource on the same media element
  }

  /**
   * Wire the addListener signature the store uses:
   *   `player.addListener('playbackStatusUpdate', cb)`
   * The event name is validated at call time so callers don't silently miss typos.
   */
  addListener(event: 'playbackStatusUpdate', callback: (status: PlaybackStatusUpdate) => void): void {
    if (event === 'playbackStatusUpdate') {
      this.listeners.push(callback);
    }
  }

  /** Destroy hls.js, clear the audio element, and unsubscribe all listeners. */
  remove(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners = [];
    this.hls.destroy();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load(); // abort any pending network requests
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private emit(partial: Partial<PlaybackStatusUpdate>): void {
    const status: PlaybackStatusUpdate = {
      isLoaded: this.isLoaded,
      playing: this.playing,
      currentTime: this.currentTime,
      duration: this.duration,
      didJustFinish: false,
      ...partial,
    };
    for (const cb of this.listeners) {
      cb(status);
    }
  }

  private wireAudioEvents(): void {
    this.audio.ontimeupdate = () => this.emit({});

    this.audio.onplay = () => this.emit({ playing: true });

    this.audio.onpause = () => this.emit({ playing: false });

    this.audio.onseeked = () => this.emit({});

    this.audio.onloadeddata = () => this.emit({ isLoaded: true });

    this.audio.onended = () => this.emit({ playing: false, didJustFinish: true });

    this.audio.onerror = () => this.emit({ isLoaded: false, playing: false });
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a web HLS player for Chrome/Firefox.
 *
 * Default deps (`Audio`, `Hls`) are resolved lazily at call time — NOT at
 * module evaluation — so that test environments without browser globals can
 * `require()` this module and inject fakes without hitting a ReferenceError.
 *
 * @param url  - The HLS master playlist URL (tokenized; EXT-X-KEY fetched automatically).
 * @param deps - Optional DI override for unit tests (inject fake Audio + Hls constructors).
 */
export function createWebHlsPlayer(
  url: string,
  deps?: WebHlsPlayerDeps,
): PlayerEngine {
  const resolved: WebHlsPlayerDeps = deps ?? { AudioCtor: Audio, HlsCtor: Hls };
  return new WebHlsPlayerImpl(url, resolved);
}
