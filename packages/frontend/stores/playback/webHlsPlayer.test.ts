/**
 * Unit tests for WebHlsPlayer using injected fake Audio + Hls constructors.
 *
 * jsdom does not implement HTMLAudioElement fully, and hls.js requires
 * MediaSource APIs not available in jest-expo. We inject minimal fakes via
 * the DI slot (WebHlsPlayerDeps) to test the pure mapping logic without any
 * real browser APIs.
 */
import type { PlaybackStatusUpdate } from './playerEngine';
import type Hls from 'hls.js';

// Dynamic import of the .web.ts file directly (jest-expo defaults to 'ios';
// we need the web implementation explicitly).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createWebHlsPlayer } = require('./webHlsPlayer.web') as typeof import('./webHlsPlayer.web');

// ── Fakes ─────────────────────────────────────────────────────────────────────

/** Minimal stand-in for HTMLAudioElement. */
class FakeAudio {
  src = '';
  volume = 1;
  paused = true;
  currentTime = 0;
  duration = NaN;
  readyState = 0;
  playError: unknown = null;

  ontimeupdate: (() => void) | null = null;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onseeked: (() => void) | null = null;
  onloadeddata: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  play(): Promise<void> {
    this.paused = false;
    this.onplay?.();
    if (this.playError) {
      return Promise.reject(this.playError);
    }
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.onpause?.();
  }

  removeAttribute(_name: string): void {
    this.src = '';
  }

  load(): void {}
}

/** Minimal stand-in for Hls. */
class FakeHls {
  loadedUrl = '';
  attachedMedia: FakeAudio | null = null;
  destroyed = false;

  loadSource(url: string): void {
    this.loadedUrl = url;
  }

  attachMedia(media: FakeAudio): void {
    this.attachedMedia = media;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

// ── Factory helper ────────────────────────────────────────────────────────────

function makePlayer(url = 'https://cdn/master.m3u8') {
  const audio = new FakeAudio();
  const hls = new FakeHls();

  const deps = {
    AudioCtor: function() { return audio; } as unknown as typeof Audio,
    HlsCtor: function() { return hls; } as unknown as typeof Hls,
  };

  const player = createWebHlsPlayer(url, deps);
  return { player, audio, hls };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createWebHlsPlayer', () => {
  it('loads source and attaches media on construction', () => {
    const { hls, audio } = makePlayer();
    expect(hls.loadedUrl).toBe('https://cdn/master.m3u8');
    expect(hls.attachedMedia).toBe(audio);
  });

  it('play() calls audio.play() and playing becomes true', () => {
    const { player, audio } = makePlayer();
    player.play();
    expect(audio.paused).toBe(false);
    expect(player.playing).toBe(true);
  });

  it('pause() calls audio.pause() and playing becomes false', () => {
    const { player, audio } = makePlayer();
    player.play();
    player.pause();
    expect(audio.paused).toBe(true);
    expect(player.playing).toBe(false);
  });

  it('volume get/set maps to audio.volume', () => {
    const { player, audio } = makePlayer();
    player.volume = 0.5;
    expect(audio.volume).toBe(0.5);
    expect(player.volume).toBe(0.5);
  });

  it('currentTime maps to audio.currentTime', () => {
    const { player, audio } = makePlayer();
    audio.currentTime = 42;
    expect(player.currentTime).toBe(42);
  });

  it('duration returns 0 when audio.duration is NaN', () => {
    const { player } = makePlayer();
    expect(player.duration).toBe(0);
  });

  it('duration returns the finite value when set', () => {
    const { player, audio } = makePlayer();
    audio.duration = 180;
    expect(player.duration).toBe(180);
  });

  it('isLoaded is false when readyState < 2', () => {
    const { player, audio } = makePlayer();
    audio.readyState = 1;
    expect(player.isLoaded).toBe(false);
  });

  it('isLoaded is true when readyState >= 2', () => {
    const { player, audio } = makePlayer();
    audio.readyState = 2;
    expect(player.isLoaded).toBe(true);
  });

  it('seekTo sets audio.currentTime', async () => {
    const { player, audio } = makePlayer();
    await player.seekTo(99);
    expect(audio.currentTime).toBe(99);
  });

  it('replace() calls hls.loadSource with the new URI', () => {
    const { player, hls } = makePlayer();
    player.replace({ uri: 'https://cdn/other.m3u8' });
    expect(hls.loadedUrl).toBe('https://cdn/other.m3u8');
  });

  it('remove() destroys hls, pauses audio, and clears src', () => {
    const { player, audio, hls } = makePlayer();
    player.remove();
    expect(hls.destroyed).toBe(true);
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe('');
  });

  it('remove() is idempotent', () => {
    const { player } = makePlayer();
    expect(() => {
      player.remove();
      player.remove();
    }).not.toThrow();
  });

  it('handles play promise aborts after remove()', async () => {
    const { player, audio } = makePlayer();
    audio.playError = { name: 'AbortError' };

    player.play();
    player.remove();
    await Promise.resolve();

    expect(audio.paused).toBe(true);
  });

  describe('addListener / status events', () => {
    it('emits playbackStatusUpdate on timeupdate', () => {
      const { player, audio } = makePlayer();
      const statuses: PlaybackStatusUpdate[] = [];
      player.addListener('playbackStatusUpdate', (s) => statuses.push(s));

      audio.currentTime = 10;
      audio.readyState = 4;
      audio.ontimeupdate?.();

      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.currentTime).toBe(10);
      expect(statuses[0]?.didJustFinish).toBe(false);
    });

    it('emits playing=true on play event', () => {
      const { player, audio } = makePlayer();
      const statuses: PlaybackStatusUpdate[] = [];
      player.addListener('playbackStatusUpdate', (s) => statuses.push(s));

      audio.play();

      expect(statuses.some((s) => s.playing === true)).toBe(true);
    });

    it('emits playing=false on pause event', () => {
      const { player, audio } = makePlayer();
      const statuses: PlaybackStatusUpdate[] = [];
      player.addListener('playbackStatusUpdate', (s) => statuses.push(s));

      audio.play();
      audio.pause();

      expect(statuses[statuses.length - 1]?.playing).toBe(false);
    });

    it('emits didJustFinish=true on ended', () => {
      const { player, audio } = makePlayer();
      const statuses: PlaybackStatusUpdate[] = [];
      player.addListener('playbackStatusUpdate', (s) => statuses.push(s));

      audio.onended?.();

      expect(statuses[0]?.didJustFinish).toBe(true);
      expect(statuses[0]?.playing).toBe(false);
    });

    it('emits isLoaded=true on loadeddata when readyState >= 2', () => {
      const { player, audio } = makePlayer();
      const statuses: PlaybackStatusUpdate[] = [];
      player.addListener('playbackStatusUpdate', (s) => statuses.push(s));

      audio.readyState = 3;
      audio.onloadeddata?.();

      expect(statuses[0]?.isLoaded).toBe(true);
    });

    it('stops emitting after remove()', () => {
      const { player, audio } = makePlayer();
      const statuses: PlaybackStatusUpdate[] = [];
      player.addListener('playbackStatusUpdate', (s) => statuses.push(s));

      player.remove();
      audio.ontimeupdate?.();

      expect(statuses).toHaveLength(0);
    });
  });
});
