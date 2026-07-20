import type { Track } from '@syra/shared-types';
import { createAudioPlayer } from 'expo-audio';
import { resolveStream } from '@/services/streamService';
import { attachSource } from './playback/attachSource';
import { usePlayerStore } from './playerStore';
import { castController } from '@/services/cast/castService';
import { CAST_HLS_CONTENT_TYPE, CAST_PROGRESSIVE_CONTENT_TYPE } from '@/services/cast/types';
import {
  castTestEngine,
  fireCastSessionState,
  getCastContentType,
  resetCastMock,
  setCastSessionState,
} from '@/services/cast/__mocks__/castService';

// ── Mocks: isolate the store from IO so we exercise the cast routing seams only.
// Explicit factory (not a bare manual mock) because jest-expo resolves the import
// to the `.native` platform variant, which a bare `__mocks__/castService` would
// not match. The test's direct import below shares this same module instance.
jest.mock('@/services/cast/castService', () => require('@/services/cast/__mocks__/castService'));

jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(() => ({
    playing: false,
    isLoaded: true,
    currentTime: 0,
    duration: 0,
    volume: 1,
    play: jest.fn(),
    pause: jest.fn(),
    setPlaybackRate: jest.fn(),
    seekTo: jest.fn(async () => {}),
    replace: jest.fn(),
    addListener: jest.fn(),
    remove: jest.fn(),
  })),
}));

jest.mock('./playback/attachSource', () => ({
  attachSource: jest.fn(() => ({ detach: jest.fn() })),
}));

jest.mock('./playback/webHlsPlayer', () => ({
  createWebHlsPlayer: jest.fn(),
}));

jest.mock('@/services/streamService', () => ({
  resolveStream: jest.fn(),
  resolveEpisodeStream: jest.fn(),
  prefetchStreams: jest.fn(),
}));

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: {
    hasValidToken: jest.fn(() => true),
    onTokensChanged: jest.fn(() => () => {}),
    waitForAuth: jest.fn(async () => true),
    getFileDownloadUrl: jest.fn((id: string) => `https://files/${id}`),
  },
}));

jest.mock('@/utils/api', () => ({
  getApiOrigin: jest.fn(() => 'https://api.syra.fm'),
  api: { get: jest.fn() },
}));

jest.mock('@/services/libraryService', () => ({
  libraryService: { recordRecentlyPlayed: jest.fn(async () => {}) },
}));

// A closed, empty station: autoplay finds nothing to append, so these suites
// exercise completion/handoff without the radio engine extending the queue.
jest.mock('@/services/radioService', () => ({
  radioService: {
    getPage: jest.fn(async () => ({ tracks: [], cursor: null, gate: null })),
    reset: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/episodeService', () => ({
  episodeService: { saveProgress: jest.fn(async () => {}) },
}));

jest.mock('./queueStore', () => ({
  useQueueStore: {
    getState: jest.fn(() => ({
      queue: null,
      replaceQueue: jest.fn(async () => {}),
      addToQueue: jest.fn(async () => {}),
      setCurrentIndex: jest.fn(async () => {}),
      syncQueue: jest.fn(),
      repeat: 'off',
      shuffle: 'off',
    })),
  },
}));

jest.mock('./musicPreferencesStore', () => ({
  getCurrentMusicPreferences: jest.fn(() => ({ autoplay: false })),
}));

jest.mock('./playerStore.config', () => ({
  ...jest.requireActual('./playerStore.config'),
  // Avoid the real 500ms post-play wait so specs stay fast and deterministic.
  PLAYBACK_INIT_DELAY_MS: 0,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const resolveStreamMock = resolveStream as jest.Mock;
const createAudioPlayerMock = createAudioPlayer as jest.Mock;
const attachSourceMock = attachSource as jest.Mock;

/** Track with HLS renditions → routed through resolveStream / the stream endpoint. */
const hlsTrack: Track = {
  id: '6a34c2c5d1646e517424358f',
  title: 'Track One',
  artistId: '6a34c2c5d1646e5174243590',
  artistName: 'Artist One',
  duration: 180,
  isExplicit: false,
  isAvailable: true,
  source: 'upload',
  status: 'ready',
  hls: [{ manifestKey: 'hls/a/master.m3u8', bitrateKbps: 128, encrypted: true }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * Uploaded track with no HLS renditions → no stream resolution, so playback
 * falls back to the plain authenticated-URL path and the receiver is handed a
 * PROGRESSIVE stream. This is the only way a progressive stream reaches the
 * cast receiver now that provider streams are gone.
 */
const progressiveTrack: Track = {
  id: '6a34c2c5d1646e5174243591',
  title: 'Track Two',
  artistId: '6a34c2c5d1646e5174243590',
  artistName: 'Artist One',
  duration: 200,
  isExplicit: false,
  isAvailable: true,
  source: 'upload',
  status: 'ready',
  audioSource: { url: '/audio/track-two.mp3', format: 'mp3' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** A minimal local PlayerEngine stand-in with spy methods. */
function makeFakeEngine() {
  return {
    playing: false,
    isLoaded: true,
    currentTime: 0,
    duration: 0,
    volume: 1,
    play: jest.fn(),
    pause: jest.fn(),
    setPlaybackRate: jest.fn(),
    seekTo: jest.fn(async () => {}),
    replace: jest.fn(),
    addListener: jest.fn(),
    remove: jest.fn(),
  };
}

/** Flush the microtask + timer queues so the async handoff settles. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function resetPlayerStore(): void {
  usePlayerStore.setState({
    currentTrack: null,
    currentEpisode: null,
    episodeQueue: [],
    episodeIndex: 0,
    playbackRate: 1,
    isPlaying: false,
    isLoading: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    player: null,
    error: null,
    context: null,
    isCasting: false,
    castDeviceName: null,
  });
}

describe('playerStore — Google Cast routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCastMock();
    resetPlayerStore();
  });

  afterEach(async () => {
    // Clears the position-update interval started during playback.
    await usePlayerStore.getState().stop();
  });

  it('routes a fresh playTrack through the cast engine, skipping the local engine and attachSource', async () => {
    resolveStreamMock.mockResolvedValue({ url: 'https://cdn/hls/a.m3u8', type: 'hls', expiresAt: null });

    // Connect first — the store's casting flag flips via the session subscription.
    fireCastSessionState('connected');
    expect(usePlayerStore.getState().isCasting).toBe(true);

    await usePlayerStore.getState().playTrack(hlsTrack);

    expect(castTestEngine.replace).toHaveBeenCalledWith({ uri: 'https://cdn/hls/a.m3u8' });
    expect(castController.setMediaMetadata).toHaveBeenCalled();
    // An HLS stream is loaded onto the receiver as an m3u8 playlist.
    expect(castController.setContentType).toHaveBeenCalledWith(CAST_HLS_CONTENT_TYPE);
    expect(getCastContentType()).toBe(CAST_HLS_CONTENT_TYPE);
    expect(createAudioPlayerMock).not.toHaveBeenCalled();
    expect(attachSourceMock).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().player).toBe(castTestEngine);
  });

  it('loads a progressive stream onto the cast receiver as audio/mpeg, not HLS', async () => {
    fireCastSessionState('connected');
    expect(usePlayerStore.getState().isCasting).toBe(true);

    await usePlayerStore.getState().playTrack(progressiveTrack);

    // No HLS renditions → no stream resolution → the authenticated-URL path,
    // which falls back to the track's own audio source.
    expect(resolveStreamMock).not.toHaveBeenCalled();
    expect(castTestEngine.replace).toHaveBeenCalledWith({ uri: 'https://api.syra.fm/audio/track-two.mp3' });
    // A progressive MP3 must NOT be announced as HLS or the receiver plays silence.
    expect(castController.setContentType).toHaveBeenCalledWith(CAST_PROGRESSIVE_CONTENT_TYPE);
    expect(getCastContentType()).toBe(CAST_PROGRESSIVE_CONTENT_TYPE);
    expect(usePlayerStore.getState().player).toBe(castTestEngine);
  });

  it('hands the current track to the cast engine at the preserved position on connect', async () => {
    resolveStreamMock.mockResolvedValue({ url: 'https://cdn/hls/b.m3u8', type: 'hls', expiresAt: null });
    const previousPlayer = makeFakeEngine();
    usePlayerStore.setState({
      currentTrack: hlsTrack,
      currentTime: 30,
      isPlaying: true,
      isCasting: false,
      player: previousPlayer,
    });

    fireCastSessionState('connected');
    await flush();

    expect(usePlayerStore.getState().isCasting).toBe(true);
    expect(usePlayerStore.getState().castDeviceName).toBe('Living Room TV');
    expect(previousPlayer.remove).toHaveBeenCalled();
    expect(castTestEngine.replace).toHaveBeenCalledWith({ uri: 'https://cdn/hls/b.m3u8' });
    expect(castTestEngine.seekTo).toHaveBeenCalledWith(30);
    expect(castTestEngine.play).toHaveBeenCalled();
    expect(attachSourceMock).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().player).toBe(castTestEngine);
  });

  it('hands the current track back to the local engine on disconnect', async () => {
    resolveStreamMock.mockResolvedValue({ url: 'https://cdn/hls/c.m3u8', type: 'hls', expiresAt: null });
    setCastSessionState('connected');
    usePlayerStore.setState({
      currentTrack: hlsTrack,
      currentTime: 12,
      isPlaying: true,
      isCasting: true,
      player: castTestEngine,
    });

    fireCastSessionState('available');
    await flush();

    expect(usePlayerStore.getState().isCasting).toBe(false);
    expect(usePlayerStore.getState().castDeviceName).toBeNull();
    expect(castTestEngine.remove).toHaveBeenCalled();
    expect(createAudioPlayerMock).toHaveBeenCalled();
    expect(attachSourceMock).toHaveBeenCalled();
  });
});
