/**
 * PlayerStore
 * Centralized state management for audio playback
 * 
 * Handles:
 * - Track playback and control
 * - Queue management integration
 * - Position tracking and seeking
 * - Volume control
 * - Repeat and shuffle modes
 */

import { create } from 'zustand';
import { createAudioPlayer } from 'expo-audio';
import { Platform } from 'react-native';
import { Track, PlaybackContext, RepeatMode } from '@syra/shared-types';
import { createScopedLogger } from '@/utils/logger';
import { useQueueStore } from './queueStore';
import {
  POSITION_UPDATE_INTERVAL_MS,
  AUDIO_PLAYER_UPDATE_INTERVAL_MS,
  PLAYBACK_INIT_DELAY_MS,
  DEFAULT_VOLUME,
  MIN_VOLUME,
  MAX_VOLUME,
} from './playerStore.config';
import {
  resolveTrackId,
  fetchAuthenticatedAudioUrl,
  resolveAudioUrlWithFallback,
  calculateTrackDuration,
  clampVolume,
} from './playerStore.helpers';
import { prefetchStreams, resolveStream, StreamResolution } from '@/services/streamService';
import { libraryService, type ListeningSource } from '@/services/libraryService';
import { browseService } from '@/services/browseService';
import { authenticatedClient } from '@/utils/api';
import { attachSource } from './playback/attachSource';
import type { AttachResult } from './playback/attachSource.types';
import type { PlayerEngine } from './playback/playerEngine';
import { pickPlaybackMode, canPlayHlsNatively } from './playback/pickPlaybackMode';
import { createWebHlsPlayer } from './playback/webHlsPlayer';
import { isRealFinish } from './playback/isRealFinish';
import { useMusicPreferencesStore } from './musicPreferencesStore';

const logger = createScopedLogger('PlayerStore');

/**
 * Player state interface
 */
interface PlayerState {
  currentTrack: Track | null;
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  player: PlayerEngine | null;
  error: string | null;
  context: PlaybackContext | null;
  
  // Actions
  playTrack: (track: Track, context?: PlaybackContext, addToQueue?: boolean) => Promise<void>;
  playTrackList: (tracks: Track[], startIndex?: number, context?: PlaybackContext) => Promise<void>;
  playFromQueue: (index: number) => Promise<void>;
  playNext: () => Promise<void>;
  playPrevious: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seek: (position: number) => Promise<void>;
  setVolume: (volume: number) => void;
  stop: () => Promise<void>;
  updateCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  handleTrackCompletion: () => Promise<void>;
}

export const usePlayerStore = create<PlayerState>((set, get) => {
  let positionUpdateInterval: ReturnType<typeof setInterval> | null = null;
  /** Teardown for the active attachSource (hls.js etc.) — called before attach or stop. */
  let currentDetach: AttachResult | null = null;
  let completionInFlight = false;

  /**
   * The play currently being tracked for engagement signalling. When the next
   * play starts (or the current one finishes), the recommendation engine is
   * told how much of THIS track was actually heard, which is what lets the
   * backend distinguish a real play from a skip and learn the user's taste.
   */
  let activePlay: { trackId: string; source: ListeningSource; durationSec: number } | null = null;

  /** Map a playback context to the listening source the backend understands. */
  const contextToSource = (context: PlaybackContext | null | undefined): ListeningSource => {
    switch (context?.type) {
      case 'album':
        return 'album';
      case 'artist':
        return 'artist';
      case 'playlist':
        return 'playlist';
      case 'library':
        return 'library';
      case 'search':
        return 'search';
      default:
        return 'unknown';
    }
  };

  /**
   * Flush the engagement signal for the play currently being tracked, using the
   * given listened position (defaults to the store's last-known position).
   * Fire-and-forget; clears the tracked play so it is reported at most once.
   */
  const flushPlaySignal = (listenedSecOverride?: number): void => {
    const play = activePlay;
    if (!play) return;
    activePlay = null;

    if (!authenticatedClient.getAccessToken()) return;

    const listenedSec = finiteSeconds(listenedSecOverride ?? get().currentTime);
    const durationSec = play.durationSec || finiteSeconds(get().duration);
    const completion = durationSec > 0 ? Math.min(1, listenedSec / durationSec) : undefined;

    void libraryService.recordRecentlyPlayed(play.trackId, {
      listenedSec,
      completion,
      source: play.source,
    });
  };

  const finiteSeconds = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

  /**
   * Start position update interval
   * Updates player position, duration, and playing state at regular intervals
   */
  const startPositionUpdates = (player: PlayerEngine) => {
    if (positionUpdateInterval) {
      clearInterval(positionUpdateInterval);
    }
    
    positionUpdateInterval = setInterval(() => {
      try {
        if (player.isLoaded) {
          set({ 
            currentTime: player.currentTime || 0,
            duration: player.duration || get().duration,
            isPlaying: player.playing || false,
          });
        }
      } catch (error) {
        logger.error('Error updating position', error);
      }
    }, POSITION_UPDATE_INTERVAL_MS);
  };

  /**
   * Stop position update interval
   */
  const stopPositionUpdates = () => {
    if (positionUpdateInterval) {
      clearInterval(positionUpdateInterval);
      positionUpdateInterval = null;
    }
  };

  /**
   * Setup player event listeners
   * Handles playback status updates and track completion
   */
  const setupPlayerListeners = (player: PlayerEngine) => {
    player.addListener('playbackStatusUpdate', (status) => {
      if (!status.isLoaded) return;

      if (status.didJustFinish) {
        // Use the store's known duration as the reliable reference — stream
        // engines report duration=0 before metadata loads and can fire a
        // spurious didJustFinish at the very start of playback.
        const knownDuration =
          finiteSeconds(status.duration) ||
          finiteSeconds(get().duration) ||
          finiteSeconds(get().currentTrack?.duration);
        const position = finiteSeconds(status.currentTime) || finiteSeconds(get().currentTime);
        if (isRealFinish(knownDuration, position)) {
          logger.debug('Track finished, handling completion');
          get().handleTrackCompletion();
        } else {
          logger.debug('Ignoring spurious didJustFinish', { position, knownDuration });
        }
        return;
      }

      set({
        isPlaying: status.playing || false,
        currentTime: finiteSeconds(status.currentTime),
        duration: finiteSeconds(status.duration) || get().duration,
      });
    });
  };

  /**
   * Update queue state after track starts playing
   */
  const updateQueueState = async (track: Track, addToQueue: boolean) => {
    const queueStore = useQueueStore.getState();
    
    if (addToQueue) {
      await queueStore.addToQueue([track.id], 'last');
      return;
    }

    const queue = queueStore.queue;
    if (queue) {
      const trackIndex = queue.tracks.findIndex(t => t.id === track.id);
      if (trackIndex >= 0) {
        await queueStore.setCurrentIndex(trackIndex);
        return;
      }
    }

    queueStore.syncQueue({
      current: 0,
      tracks: [track],
      context: get().context ?? undefined,
    });
  };

  const seedLocalQueue = (tracks: Track[], startIndex: number, context?: PlaybackContext) => {
    const playableTracks = tracks.filter((track) => track?.id);
    if (playableTracks.length === 0) {
      return null;
    }

    const clampedIndex = Math.max(0, Math.min(startIndex, playableTracks.length - 1));
    const queue = {
      current: clampedIndex,
      tracks: playableTracks,
      context,
    };

    useQueueStore.getState().syncQueue(queue);
    return queue;
  };

  const shouldResolveViaStreamEndpoint = (track: Track): boolean => {
    const hasHls = track.status === 'ready' && Array.isArray(track.hls) && track.hls.length > 0;
    const canUseDirectAudius =
      track.source === 'audius' &&
      !track.audioSource &&
      useMusicPreferencesStore.getState().preferences?.directAudiusStreaming === true;

    return hasHls || canUseDirectAudius;
  };

  const prefetchQueueStreams = (
    tracks: Track[],
    startIndex: number,
    options: { includeCurrent?: boolean } = {},
  ): void => {
    const from = options.includeCurrent ? startIndex : startIndex + 1;
    const ids = tracks
      .slice(Math.max(0, from), Math.max(0, from) + 4)
      .filter(shouldResolveViaStreamEndpoint)
      .map((track) => track.id);

    if (ids.length > 0) {
      prefetchStreams(ids);
    }
  };

  const prefetchUpcomingQueueStreams = (): void => {
    const queue = useQueueStore.getState().queue;
    if (!queue) {
      return;
    }
    prefetchQueueStreams(queue.tracks, queue.current);
  };

  const getRandomNextIndex = (current: number, length: number): number => {
    if (length <= 1) {
      return current;
    }

    const candidates = Array.from({ length }, (_value, index) => index).filter((index) => index !== current);
    return candidates[Math.floor(Math.random() * candidates.length)] ?? current;
  };

  const chooseNextIndex = (fromCompletion: boolean): number | null => {
    const { queue, shuffle, repeat } = useQueueStore.getState();
    if (!queue || queue.tracks.length === 0) {
      return null;
    }

    if (repeat === RepeatMode.ONE && fromCompletion) {
      return queue.current;
    }

    if (shuffle === 'on') {
      return getRandomNextIndex(queue.current, queue.tracks.length);
    }

    const nextIndex = queue.current + 1;
    if (nextIndex < queue.tracks.length) {
      return nextIndex;
    }

    return repeat === RepeatMode.ALL ? 0 : null;
  };

  const extendQueueForAutoplay = async (finishedTrack?: Track | null): Promise<boolean> => {
    const preferences = useMusicPreferencesStore.getState().preferences;
    if (preferences?.autoplay === false) {
      return false;
    }

    const queueStore = useQueueStore.getState();
    const queue = queueStore.queue;
    const seenIds = new Set(queue?.tracks.map((track) => track.id) ?? []);
    const currentTrackId = finishedTrack?.id ?? get().currentTrack?.id;
    if (currentTrackId) {
      seenIds.add(currentTrackId);
    }

    try {
      const response = await browseService.getPopularTracks({ limit: 30, offset: 0 });
      const candidates = response.tracks.filter((track) => track.id && !seenIds.has(track.id));
      if (candidates.length === 0) {
        return false;
      }

      const additions = candidates.slice(0, 12);
      queueStore.syncQueue({
        current: queue?.current ?? -1,
        tracks: [...(queue?.tracks ?? []), ...additions],
        context: queue?.context ?? {
          type: 'track',
          name: 'Autoplay',
        },
      });
      return true;
    } catch (error) {
      logger.warn('Failed to extend queue for autoplay', error);
      return false;
    }
  };

  /**
   * Initialize the playback engine for the given URL and optional resolution.
   *
   * For web + HLS streams that need hls.js (Chrome/Firefox), creates a
   * WebHlsPlayer backed by a raw HTMLAudioElement. All other combinations use
   * expo-audio's AudioPlayer, which handles native HLS via AVPlayer/ExoPlayer
   * and progressive streams universally.
   */
  const initializePlayer = async (
    audioUrl: string,
    track: Track,
    resolution: StreamResolution | null,
  ): Promise<PlayerEngine> => {
    logger.debug('Initializing playback engine', { url: audioUrl, trackId: track.id });

    const mode =
      resolution !== null
        ? pickPlaybackMode({
            type: resolution.type,
            isWeb: Platform.OS === 'web',
            canPlayHlsNatively: canPlayHlsNatively(),
          })
        : 'progressive';

    logger.debug('Playback mode selected', { mode });

    if (mode === 'hlsjs') {
      const engine = createWebHlsPlayer(audioUrl);
      engine.volume = get().volume;
      setupPlayerListeners(engine);
      return engine;
    }

    const player = createAudioPlayer(audioUrl, {
      updateInterval: AUDIO_PLAYER_UPDATE_INTERVAL_MS,
    });

    player.volume = get().volume;
    setupPlayerListeners(player);

    return player;
  };

  /**
   * Start playback and wait for initialization
   */
  const startPlayback = async (player: PlayerEngine, track: Track): Promise<void> => {
    logger.debug('Starting playback', { trackId: track.id });
    
    player.play();
    
    // Wait for player to initialize
    await new Promise(resolve => setTimeout(resolve, PLAYBACK_INIT_DELAY_MS));
    
    const duration = calculateTrackDuration(
      track.duration,
      player.duration,
      player.isLoaded
    );

    set({ 
      isPlaying: player.playing,
      isLoading: false,
      duration,
      currentTime: player.currentTime || 0,
    });
  };

  /**
   * Resolve a playable audio URL for a track.
   *
   * Uploaded tracks (those with an `audioSource`) are served via a short-lived
   * pre-signed S3 URL fetched from the authenticated endpoint, falling back to
   * the direct Syra API URL if that request fails. Provider streams are resolved
   * through `resolveStream`, not from catalog payload fields.
   *
   * @throws Error when the track has no resolvable playable source
   */
  const getAudioUrl = async (track: Track): Promise<string> => {
    if (!track.audioSource) {
      if (track.source === 'audius') {
        throw new Error('This Audius track is not available through Syra streaming. Enable direct Audius streaming in Settings to try the provider stream.');
      }
      throw new Error(`Track ${track.id} has no playable audio source`);
    }

    const trackId = resolveTrackId(track);

    try {
      logger.debug('Fetching authenticated audio URL', { trackId });
      const url = await fetchAuthenticatedAudioUrl(trackId);
      logger.debug('Successfully fetched authenticated URL');
      return url;
    } catch (error) {
      logger.warn('Failed to fetch authenticated URL, using fallback', { error, trackId });
      const fallbackUrl = resolveAudioUrlWithFallback(track);
      if (!fallbackUrl) {
        throw new Error(`Track ${track.id} has no playable audio source`);
      }
      return fallbackUrl;
    }
  };

  /**
   * Resolve the stream for tracks that have Phase-3 HLS renditions or are
   * Audius-sourced. Returns null for tracks that should use the legacy
   * `getAudioUrl` path (still-processing, failed, or upload-only).
   */
  /**
   * Record a play in the user's recently-played history.
   *
   * Fire-and-forget: called once a track has actually started so the home
   * screen's real "Recently played" / "Jump back in" section is populated.
   * Only runs for authenticated users (an access token is present) — guests
   * have no server-side history, so we skip the request entirely rather than
   * provoke a 401. The service itself swallows/logs any failure, so this never
   * affects playback.
   */
  const recordPlay = (track: Track, context?: PlaybackContext | null): void => {
    // Flush the engagement signal for whatever was playing before this track so
    // the outgoing play's completion/skip is captured exactly once.
    flushPlaySignal();

    if (!authenticatedClient.getAccessToken()) {
      activePlay = null;
      return;
    }

    const source = contextToSource(context ?? get().context);
    // Signal-less start ping: populates "Jump back in" immediately. The
    // engagement ping (with listenedSec/completion) is sent on flush.
    void libraryService.recordRecentlyPlayed(track.id, { source });
    activePlay = { trackId: track.id, source, durationSec: finiteSeconds(track.duration) };
  };

  const getPhase3Resolution = async (track: Track): Promise<StreamResolution | null> => {
    if (!shouldResolveViaStreamEndpoint(track)) {
      return null;
    }
    logger.debug('Resolving Phase-3 stream', { trackId: track.id });
    return resolveStream(track.id);
  };

  return {
    currentTrack: null,
    isPlaying: false,
    isLoading: false,
    currentTime: 0,
    duration: 0,
    volume: DEFAULT_VOLUME,
    player: null,
    error: null,
    context: null,

    /**
     * Play a track
     * @param track - The track to play
     * @param context - Optional playback context
     * @param addToQueue - Whether to add track to queue
     */
    playTrack: async (track: Track, context?: PlaybackContext, addToQueue: boolean = false) => {
      try {
        logger.info('Playing track', {
          trackId: track.id,
          title: track.title,
          url: track.audioSource?.url,
        });
        
        // Stop current track if playing
        const { player: currentPlayer, stop } = get();
        if (currentPlayer) {
          await stop();
        }

        set({
          isLoading: true,
          error: null,
          currentTrack: track,
          context: context || null,
        });

        // Resolve stream — Phase-3 HLS or Audius tracks use resolveStream;
        // legacy/processing tracks fall back to the authenticated-URL path.
        const resolution = await getPhase3Resolution(track);
        const audioUrl = resolution
          ? resolution.url
          : await getAudioUrl(track);
        logger.debug('Audio URL resolved', { url: audioUrl, type: resolution?.type });

        // Initialize the engine — for web+HLS this creates a WebHlsPlayer;
        // all other cases use expo-audio's AudioPlayer.
        const player = await initializePlayer(audioUrl, track, resolution);

        // Attach source via platform-aware fork. The engine was already
        // selected above so attachSource.web.ts simply calls player.replace(),
        // which routes to hls.loadSource() inside WebHlsPlayer for hlsjs mode.
        if (currentDetach) {
          currentDetach.detach();
          currentDetach = null;
        }
        if (resolution) {
          currentDetach = attachSource(player, resolution);
        }
        
        set({ 
          player,
          isLoading: true,
          currentTime: 0,
          duration: track.duration || 0,
        });

        try {
          await updateQueueState(track, addToQueue);
          await startPlayback(player, track);
          startPositionUpdates(player);
          prefetchUpcomingQueueStreams();
          // Track started successfully — record it for real recently-played.
          recordPlay(track, context);
        } catch (playError) {
          logger.error('Error during playback', playError);
          set({ 
            isPlaying: false,
            isLoading: false,
            error: playError instanceof Error ? playError.message : 'Failed to play audio',
          });
          throw playError;
        }
      } catch (error) {
        logger.error('Error playing track', error);
        set({ 
          error: error instanceof Error ? error.message : 'Failed to play track',
          isLoading: false,
          isPlaying: false,
        });
      }
    },

    /**
     * Play a track from a finite context and make the rest of that context the
     * active queue. Album, playlist, liked songs, and search screens should use
     * this instead of playing an isolated track.
     */
    playTrackList: async (tracks: Track[], startIndex: number = 0, context?: PlaybackContext) => {
      const queue = seedLocalQueue(tracks, startIndex, context);
      if (!queue) {
        return;
      }

      prefetchQueueStreams(queue.tracks, queue.current, { includeCurrent: true });
      await get().playTrack(queue.tracks[queue.current], context ?? queue.context, false);
    },

    /**
     * Pause playback
     */
    pause: async () => {
      const { player } = get();
      if (player) {
        player.pause();
        set({ isPlaying: false });
        logger.debug('Playback paused');
      }
    },

    /**
     * Resume playback
     */
    resume: async () => {
      const { player } = get();
      if (player) {
        player.play();
        set({ isPlaying: true });
        logger.debug('Playback resumed');
      }
    },

    /**
     * Seek to position
     * @param position - Position in seconds
     */
    seek: async (position: number) => {
      const { player } = get();
      if (player) {
        await player.seekTo(position);
        set({ currentTime: position });
        logger.debug('Seeked to position', { position });
      }
    },

    /**
     * Set volume
     * @param volume - Volume level (0.0 to 1.0)
     */
    setVolume: (volume: number) => {
      const clampedVolume = clampVolume(volume, MIN_VOLUME, MAX_VOLUME);
      set({ volume: clampedVolume });
      
      const { player } = get();
      if (player) {
        player.volume = clampedVolume;
      }
      
      logger.debug('Volume set', { volume: clampedVolume });
    },

    /**
     * Stop playback and cleanup
     */
    stop: async () => {
      // Capture engagement for the play being torn down before state resets.
      flushPlaySignal();
      stopPositionUpdates();
      // Tear down any hls.js instance before removing the player
      if (currentDetach) {
        currentDetach.detach();
        currentDetach = null;
      }
      const { player } = get();
      if (player) {
        try {
          player.remove();
        } catch (error) {
          logger.warn('Error removing player', error);
        }
      }
      set({ 
        player: null,
        currentTrack: null,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        error: null,
      });
      logger.debug('Playback stopped');
    },

    /**
     * Update current time (manual)
     * @param time - Current time in seconds
     */
    updateCurrentTime: (time: number) => {
      set({ currentTime: time });
    },

    /**
     * Set duration (manual)
     * @param duration - Duration in seconds
     */
    setDuration: (duration: number) => {
      set({ duration });
    },

    /**
     * Play track from queue by index
     * @param index - Queue index
     */
    playFromQueue: async (index: number) => {
      const queueStore = useQueueStore.getState();
      const queue = queueStore.queue;
      
      if (!queue || index < 0 || index >= queue.tracks.length) {
        logger.error('Invalid queue index', { index, queueLength: queue?.tracks.length });
        return;
      }

      const track = queue.tracks[index];
      await queueStore.setCurrentIndex(index);
      await get().playTrack(track, queue.context, false);
    },

    /**
     * Play next track in queue
     */
    playNext: async () => {
      let nextIndex = chooseNextIndex(false);

      if (nextIndex === null && await extendQueueForAutoplay()) {
        nextIndex = chooseNextIndex(false);
      }

      if (nextIndex !== null) {
        await get().playFromQueue(nextIndex);
      }
    },

    /**
     * Play previous track in queue
     */
    playPrevious: async () => {
      const queueStore = useQueueStore.getState();
      const { currentTime } = get();

      if (currentTime > 3) {
        await get().seek(0);
        return;
      }

      const queue = queueStore.queue;
      if (!queue || queue.tracks.length === 0) {
        return;
      }

      let previousIndex = queue.current - 1;
      if (previousIndex < 0 && queueStore.repeat === RepeatMode.ALL) {
        previousIndex = queue.tracks.length - 1;
      }

      if (previousIndex >= 0) {
        await get().playFromQueue(previousIndex);
      }
    },

    /**
     * Handle track completion
     * Automatically plays next track based on repeat mode
     */
    handleTrackCompletion: async () => {
      if (completionInFlight) {
        return;
      }

      completionInFlight = true;
      const finishedTrack = get().currentTrack;

      // The track played to its end — report a full completion (a strong
      // positive taste signal) before advancing.
      flushPlaySignal(finiteSeconds(finishedTrack?.duration) || finiteSeconds(get().duration));

      let nextIndex = chooseNextIndex(true);

      if (nextIndex === null && await extendQueueForAutoplay(finishedTrack)) {
        nextIndex = chooseNextIndex(true);
      }

      if (nextIndex !== null) {
        try {
          await get().playFromQueue(nextIndex);
        } finally {
          completionInFlight = false;
        }
        return;
      }

      await get().stop();
      completionInFlight = false;
    },
  };
});
