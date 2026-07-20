import type { ConnectPlaybackState, Track } from '@syra/shared-types';
import { usePlayerStore } from './playerStore';
import { resetCastMock } from '@/services/cast/__mocks__/castService';
import { musicService } from '@/services/musicService';
import { queueService } from '@/services/queueService';
import { useQueueStore } from './queueStore';

// ── Mocks: isolate applyRemotePlaybackState from IO. The store's own actions
// (playTrack/seek/resume/pause/stop) are replaced with spies per-test via
// setState so we assert what the remote-state handler decides to invoke,
// without booting the real playback engine.
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
// exercise remote-state handling without the radio engine extending the queue.
jest.mock('@/services/radioService', () => ({
  radioService: {
    getPage: jest.fn(async () => ({ tracks: [], cursor: null, gate: null })),
    reset: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/episodeService', () => ({
  episodeService: { saveProgress: jest.fn(async () => {}) },
}));

jest.mock('@/services/musicService', () => ({
  musicService: { getTrackById: jest.fn() },
}));

jest.mock('@/services/queueService', () => ({
  queueService: { getQueue: jest.fn() },
}));

// syncQueue is closure-scoped so getState() returns a STABLE mock reference the
// test can assert against (a fresh jest.fn() per getState() call could not be).
jest.mock('./queueStore', () => {
  const syncQueue = jest.fn();
  return {
    useQueueStore: {
      getState: jest.fn(() => ({
        queue: null,
        replaceQueue: jest.fn(async () => {}),
        addToQueue: jest.fn(async () => {}),
        setCurrentIndex: jest.fn(async () => {}),
        syncQueue,
        repeat: 'off',
        shuffle: 'off',
      })),
    },
  };
});

const mockGetTrackById = musicService.getTrackById as jest.Mock;
const mockGetQueue = queueService.getQueue as jest.Mock;
const mockSyncQueue = useQueueStore.getState().syncQueue as jest.Mock;

jest.mock('./musicPreferencesStore', () => ({
  getCurrentMusicPreferences: jest.fn(() => ({ autoplay: false })),
}));

jest.mock('./playerStore.config', () => ({
  ...jest.requireActual('./playerStore.config'),
  PLAYBACK_INIT_DELAY_MS: 0,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const THIS_DEVICE = 'device-this';
const OTHER_DEVICE = 'device-other';

function makeTrack(id: string): Track {
  return {
    id,
    title: `Track ${id}`,
    artistId: 'artist-1',
    artistName: 'Artist One',
    duration: 180,
    isExplicit: false,
    isAvailable: true,
    source: 'upload',
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeState(overrides: Partial<ConnectPlaybackState> = {}): ConnectPlaybackState {
  return {
    positionMs: 0,
    isPlaying: true,
    queue: [],
    repeat: 'off',
    shuffle: false,
    volume: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A PlayerEngine stand-in — its methods are never invoked because the store's
 *  playback actions are replaced with spies; it only needs to be truthy. */
function fakeEngine() {
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

let playTrack: jest.Mock;
let seek: jest.Mock;
let resume: jest.Mock;
let pause: jest.Mock;
let stop: jest.Mock;

function installSpies(): void {
  playTrack = jest.fn(async () => {});
  seek = jest.fn(async () => {});
  resume = jest.fn(async () => {});
  pause = jest.fn(async () => {});
  stop = jest.fn(async () => {});
  usePlayerStore.setState({ playTrack, seek, resume, pause, stop });
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
    failure: null,
    context: null,
    isCasting: false,
    castDeviceName: null,
    connectActiveDeviceId: null,
  });
}

describe('playerStore — applyRemotePlaybackState (Syra Connect)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCastMock();
    resetPlayerStore();
    installSpies();
    mockGetQueue.mockResolvedValue({ current: 0, tracks: [], previous: [], next: [], total: 0 });
  });

  it('(a) this device becomes newly active with a different track → fetches, plays, seeks, resumes', async () => {
    const track = makeTrack('track-new');
    mockGetTrackById.mockResolvedValue(track);
    usePlayerStore.setState({
      connectActiveDeviceId: null,
      currentTrack: makeTrack('track-old'),
      player: fakeEngine(),
    });

    await usePlayerStore.getState().applyRemotePlaybackState(
      makeState({ activeDeviceId: THIS_DEVICE, trackId: 'track-new', positionMs: 30000, isPlaying: true }),
      THIS_DEVICE,
    );

    expect(mockGetTrackById).toHaveBeenCalledWith('track-new');
    expect(playTrack).toHaveBeenCalledWith(track, undefined, false);
    expect(seek).toHaveBeenCalledWith(30);
    expect(resume).toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(mockSyncQueue).toHaveBeenCalled();
    expect(usePlayerStore.getState().connectActiveDeviceId).toBe(THIS_DEVICE);
  });

  it('(b) this device stays active with the SAME track → no re-fetch/re-play, just seek + pause', async () => {
    usePlayerStore.setState({
      connectActiveDeviceId: THIS_DEVICE,
      currentTrack: makeTrack('track-same'),
      player: fakeEngine(),
    });

    await usePlayerStore.getState().applyRemotePlaybackState(
      makeState({ activeDeviceId: THIS_DEVICE, trackId: 'track-same', positionMs: 60000, isPlaying: false }),
      THIS_DEVICE,
    );

    expect(mockGetTrackById).not.toHaveBeenCalled();
    expect(playTrack).not.toHaveBeenCalled();
    expect(seek).toHaveBeenCalledWith(60);
    expect(pause).toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('(c) this device WAS active and playback moved to another device → stops local audio', async () => {
    usePlayerStore.setState({
      connectActiveDeviceId: THIS_DEVICE,
      currentTrack: makeTrack('track-x'),
      player: fakeEngine(),
    });

    await usePlayerStore.getState().applyRemotePlaybackState(
      makeState({ activeDeviceId: OTHER_DEVICE, trackId: 'track-x', positionMs: 1000, isPlaying: true }),
      THIS_DEVICE,
    );

    expect(stop).toHaveBeenCalled();
    expect(playTrack).not.toHaveBeenCalled();
    expect(mockGetTrackById).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().connectActiveDeviceId).toBe(OTHER_DEVICE);
  });

  it('(d) neither before nor after involves this device → no-op', async () => {
    usePlayerStore.setState({
      connectActiveDeviceId: null,
      currentTrack: null,
      player: fakeEngine(),
    });

    await usePlayerStore.getState().applyRemotePlaybackState(
      makeState({ activeDeviceId: OTHER_DEVICE, trackId: 'track-x', positionMs: 1000, isPlaying: true }),
      THIS_DEVICE,
    );

    expect(stop).not.toHaveBeenCalled();
    expect(playTrack).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
    expect(mockGetTrackById).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().connectActiveDeviceId).toBe(OTHER_DEVICE);
  });

  it('this device becomes active but the server has no track → stops local playback', async () => {
    usePlayerStore.setState({
      connectActiveDeviceId: null,
      currentTrack: makeTrack('track-x'),
      player: fakeEngine(),
    });

    await usePlayerStore.getState().applyRemotePlaybackState(
      makeState({ activeDeviceId: THIS_DEVICE, trackId: undefined, isPlaying: false }),
      THIS_DEVICE,
    );

    expect(stop).toHaveBeenCalled();
    expect(playTrack).not.toHaveBeenCalled();
    expect(mockGetTrackById).not.toHaveBeenCalled();
  });
});
