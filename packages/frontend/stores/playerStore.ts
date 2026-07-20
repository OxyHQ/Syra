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
import { Queue, Track, Episode, PlaybackContext, RepeatMode, ConnectPlaybackState } from '@syra/shared-types';
import { createScopedLogger } from '@/utils/logger';
import { useQueueStore } from './queueStore';
import { musicService } from '@/services/musicService';
import { queueService } from '@/services/queueService';
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
import { prefetchStreams, resolveStream, resolveEpisodeStream, StreamResolution } from '@/services/streamService';
import { episodeService } from '@/services/episodeService';
import { getApiOrigin } from '@/utils/api';
import { libraryService, type ListeningSource, type PlaySignal } from '@/services/libraryService';
import { browseService } from '@/services/browseService';
import { oxyServices } from '@/lib/oxyServices';
import { attachSource } from './playback/attachSource';
import type { AttachResult } from './playback/attachSource.types';
import type { PlayerEngine } from './playback/playerEngine';
import { pickPlaybackMode, canPlayHlsNatively } from './playback/pickPlaybackMode';
import { createWebHlsPlayer } from './playback/webHlsPlayer';
import { isRealFinish } from './playback/isRealFinish';
import { getCurrentMusicPreferences } from './musicPreferencesStore';
import { castController } from '@/services/cast/castService';
import { CAST_HLS_CONTENT_TYPE, CAST_PROGRESSIVE_CONTENT_TYPE } from '@/services/cast/types';
import type { CastMediaMetadata, CastSessionState } from '@/services/cast/types';
import { pickCatalogImageUrl, resolvePodcastArtwork } from '@/utils/pickImage';

const logger = createScopedLogger('PlayerStore');
const PLAY_SIGNAL_AUTH_WAIT_MS = 20_000;
const MAX_PENDING_PLAY_SIGNALS = 16;

/** How often the player persists episode progress while playing. */
const PROGRESS_SAVE_INTERVAL_MS = 12_000;
/** Within this many seconds of the end an episode is marked completed. */
const EPISODE_COMPLETE_THRESHOLD_SEC = 30;
/** Minimum saved position worth resuming to (avoids a 0–1s jitter). */
const RESUME_MIN_SEC = 5;
/** Default podcast playback speed (1×). */
const DEFAULT_PLAYBACK_RATE = 1;

interface PendingPlaySignal {
  trackId: string;
  signal?: PlaySignal;
}

/**
 * Minimal metadata both `Track` and `Episode` satisfy — all the engine setup
 * helpers need is an id (for logging) and an optional known duration.
 */
interface PlayableMeta {
  id: string;
  duration?: number;
}

/** Options for starting episode playback. */
export interface PlayEpisodeOptions {
  /** Resume from this saved position (seconds). */
  resumeFromSec?: number;
  /** The sequential episode queue this episode belongs to. */
  queue?: Episode[];
  /** Index of this episode within `queue`. */
  index?: number;
  /** Playback context for analytics / now-playing labelling. */
  context?: PlaybackContext;
}

/**
 * Player state interface
 */
interface PlayerState {
  currentTrack: Track | null;
  /** The episode currently playing (mutually exclusive with `currentTrack`). */
  currentEpisode: Episode | null;
  /** Sequential episode queue for the active podcast playback session. */
  episodeQueue: Episode[];
  /** Index of `currentEpisode` within `episodeQueue`. */
  episodeIndex: number;
  /** Podcast playback speed (1 = normal). Only applied to episode playback. */
  playbackRate: number;
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  player: PlayerEngine | null;
  error: string | null;
  context: PlaybackContext | null;
  /** Whether playback is currently routed to a Google Cast receiver. */
  isCasting: boolean;
  /** Friendly name of the connected cast receiver, or null when not casting. */
  castDeviceName: string | null;
  /**
   * The `activeDeviceId` from the last Syra Connect state applied on this device.
   * Transient (never persisted) bookkeeping so a subsequent state can tell that
   * playback moved AWAY from this device and release the local audio engine.
   */
  connectActiveDeviceId: string | null;

  // Actions
  playTrack: (track: Track, context?: PlaybackContext, addToQueue?: boolean) => Promise<void>;
  playTrackList: (tracks: Track[], startIndex?: number, context?: PlaybackContext) => Promise<void>;
  playEpisode: (episode: Episode, options?: PlayEpisodeOptions) => Promise<void>;
  playEpisodeList: (episodes: Episode[], startIndex?: number, context?: PlaybackContext, resumeFromSec?: number) => Promise<void>;
  playFromQueue: (index: number) => Promise<void>;
  playNext: () => Promise<void>;
  playPrevious: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seek: (position: number) => Promise<void>;
  skipBy: (seconds: number) => Promise<void>;
  setVolume: (volume: number) => void;
  setPlaybackRate: (rate: number) => void;
  stop: () => Promise<void>;
  updateCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  handleTrackCompletion: () => Promise<void>;
  /**
   * Apply server-authoritative Syra Connect playback state pushed over the
   * socket. When this device is the active playback target it loads/seeks/plays
   * to match; when playback has just moved to another device it releases the
   * local audio engine.
   */
  applyRemotePlaybackState: (state: ConnectPlaybackState, localDeviceId: string | null) => Promise<void>;
}

export const usePlayerStore = create<PlayerState>((set, get) => {
  let positionUpdateInterval: ReturnType<typeof setInterval> | null = null;
  /** Periodic episode-progress persistence timer (podcast playback only). */
  let progressSaveInterval: ReturnType<typeof setInterval> | null = null;
  /** Teardown for the active attachSource (hls.js etc.) — called before attach or stop. */
  let currentDetach: AttachResult | null = null;
  let completionInFlight = false;
  let tokenDrainUnsubscribe: (() => void) | null = null;
  let pendingSignalDrainInFlight = false;
  const pendingPlaySignals: PendingPlaySignal[] = [];

  /**
   * The play currently being tracked for engagement signalling. When the next
   * play starts (or the current one finishes), the recommendation engine is
   * told how much of THIS track was actually heard, which is what lets the
   * backend distinguish a real play from a skip and learn the user's taste.
   */
  let activePlay: { trackId: string; source: ListeningSource; durationSec: number } | null = null;

  const removePendingPlaySignal = (pending: PendingPlaySignal): void => {
    const index = pendingPlaySignals.indexOf(pending);
    if (index >= 0) {
      pendingPlaySignals.splice(index, 1);
    }
  };

  const drainPendingPlaySignals = (): void => {
    if (pendingSignalDrainInFlight || !oxyServices.hasValidToken() || pendingPlaySignals.length === 0) {
      return;
    }

    pendingSignalDrainInFlight = true;
    const signals = pendingPlaySignals.splice(0, pendingPlaySignals.length);
    void Promise.all(
      signals.map((pending) => libraryService.recordRecentlyPlayed(pending.trackId, pending.signal)),
    ).finally(() => {
      pendingSignalDrainInFlight = false;
      if (pendingPlaySignals.length > 0 && oxyServices.hasValidToken()) {
        drainPendingPlaySignals();
      }
    });
  };

  const ensureTokenDrainSubscription = (): void => {
    if (tokenDrainUnsubscribe) {
      return;
    }

    tokenDrainUnsubscribe = oxyServices.onTokensChanged((accessToken) => {
      if (accessToken) {
        drainPendingPlaySignals();
      }
    });
  };

  const queuePlaySignalUntilAuthReady = (trackId: string, signal?: PlaySignal): void => {
    const pending: PendingPlaySignal = { trackId, signal };
    pendingPlaySignals.push(pending);
    if (pendingPlaySignals.length > MAX_PENDING_PLAY_SIGNALS) {
      pendingPlaySignals.shift();
    }

    ensureTokenDrainSubscription();
    void oxyServices.waitForAuth(PLAY_SIGNAL_AUTH_WAIT_MS)
      .then((authReady) => {
        if (authReady) {
          drainPendingPlaySignals();
          return;
        }
        removePendingPlaySignal(pending);
      })
      .catch((error) => {
        removePendingPlaySignal(pending);
        logger.warn('Failed while waiting for auth before recording playback', { trackId, error });
      });
  };

  const submitPlaySignal = (trackId: string, signal?: PlaySignal): void => {
    if (oxyServices.hasValidToken()) {
      void libraryService.recordRecentlyPlayed(trackId, signal);
      return;
    }

    queuePlaySignalUntilAuthReady(trackId, signal);
  };

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

    const listenedSec = finiteSeconds(listenedSecOverride ?? get().currentTime);
    const durationSec = play.durationSec || finiteSeconds(get().duration);
    const completion = durationSec > 0 ? Math.min(1, listenedSec / durationSec) : undefined;

    submitPlaySignal(play.trackId, {
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
          logger.debug('Media finished, handling completion');
          if (get().currentEpisode) {
            void handleEpisodeCompletion();
          } else {
            get().handleTrackCompletion();
          }
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

    await queueStore.replaceQueue({
      current: 0,
      tracks: [track],
      context: get().context ?? undefined,
    });
  };

  const seedLocalQueue = async (
    tracks: Track[],
    startIndex: number,
    context?: PlaybackContext,
  ): Promise<Queue | null> => {
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

    await useQueueStore.getState().replaceQueue(queue);
    return queue;
  };

  const shouldResolveViaStreamEndpoint = (track: Track): boolean =>
    track.status === 'ready' && Array.isArray(track.hls) && track.hls.length > 0;

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
    const preferences = getCurrentMusicPreferences();
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
   * Build the now-playing metadata shown on the cast receiver. Resolves artwork
   * through the same catalog/podcast image pickers the now-playing UI uses, so
   * the receiver gets a fully-qualified (off-device-reachable) artwork URL.
   */
  const buildCastMetadata = (): CastMediaMetadata => {
    const { currentEpisode, currentTrack } = get();
    if (currentEpisode) {
      return {
        title: currentEpisode.title,
        subtitle: currentEpisode.podcastTitle,
        artworkUrl: resolvePodcastArtwork(currentEpisode, 'detailArtwork'),
      };
    }
    if (currentTrack) {
      return {
        title: currentTrack.title,
        subtitle: currentTrack.artistName,
        artworkUrl: pickCatalogImageUrl(
          currentTrack.images,
          currentTrack.coverArt,
          'detailArtwork',
          currentTrack.coverArtSizes,
        ),
      };
    }
    return {};
  };

  /**
   * Initialize the playback engine for the given URL and optional resolution.
   *
   * When a cast session is connected, the active engine becomes the cast engine
   * (the receiver loads the URL directly) — every existing control flows through
   * the shared {@link PlayerEngine} interface unchanged. Otherwise, for web + HLS
   * streams that need hls.js (Chrome/Firefox), creates a WebHlsPlayer backed by a
   * raw HTMLAudioElement; all other combinations use expo-audio's AudioPlayer,
   * which handles native HLS via AVPlayer/ExoPlayer and progressive streams.
   */
  const initializePlayer = async (
    audioUrl: string,
    media: PlayableMeta,
    resolution: StreamResolution | null,
  ): Promise<PlayerEngine> => {
    logger.debug('Initializing playback engine', { url: audioUrl, trackId: media.id });

    if (castController.getSessionState() === 'connected') {
      const castEngine = castController.getEngine();
      if (castEngine) {
        logger.debug('Routing playback to cast receiver', { trackId: media.id });
        // Metadata and content type must be set before replace() so they are
        // applied to the load. HLS streams use the m3u8 MIME type; everything
        // else (a progressive MP3 from the legacy no-resolution path) is a
        // progressive stream the receiver must not be told is HLS.
        castController.setMediaMetadata(buildCastMetadata());
        castController.setContentType(
          resolution?.type === 'hls' ? CAST_HLS_CONTENT_TYPE : CAST_PROGRESSIVE_CONTENT_TYPE,
        );
        castEngine.replace({ uri: audioUrl });
        castEngine.volume = get().volume;
        setupPlayerListeners(castEngine);
        return castEngine;
      }
    }

    const mode =
      resolution !== null
        ? pickPlaybackMode({
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
  const startPlayback = async (player: PlayerEngine, media: PlayableMeta): Promise<void> => {
    logger.debug('Starting playback', { trackId: media.id });

    player.play();

    // Wait for player to initialize
    await new Promise(resolve => setTimeout(resolve, PLAYBACK_INIT_DELAY_MS));

    const duration = calculateTrackDuration(
      media.duration ?? 0,
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
   * Resolve the stream for tracks that have Phase-3 HLS renditions. Returns
   * null for tracks that should use the legacy `getAudioUrl` path
   * (still-processing, failed, or upload-only).
   */
  /**
   * Record a play in the user's recently-played history.
   *
   * Fire-and-forget: called once a track has actually started so the home
   * screen's real "Recently played" / "Jump back in" section is populated.
   * Uses SDK session readiness instead of a one-time token read. During cold
   * boot, signals wait briefly for OxyProvider to publish the restored token;
   * true guests expire without affecting playback.
   */
  const recordPlay = (track: Track, context?: PlaybackContext | null): void => {
    // Flush the engagement signal for whatever was playing before this track so
    // the outgoing play's completion/skip is captured exactly once.
    flushPlaySignal();

    const source = contextToSource(context ?? get().context);
    // Signal-less start ping: populates "Jump back in" immediately. The
    // engagement ping (with listenedSec/completion) is sent on flush.
    submitPlaySignal(track.id, { source });
    activePlay = { trackId: track.id, source, durationSec: finiteSeconds(track.duration) };
  };

  const getPhase3Resolution = async (track: Track): Promise<StreamResolution | null> => {
    if (!shouldResolveViaStreamEndpoint(track)) {
      return null;
    }
    logger.debug('Resolving Phase-3 stream', { trackId: track.id });
    return resolveStream(track.id);
  };

  // ── Episode playback helpers ───────────────────────────────────────────────

  /** Apply the store's playback rate to an engine that supports it. */
  const applyPlaybackRate = (player: PlayerEngine): void => {
    player.setPlaybackRate?.(get().playbackRate);
  };

  /**
   * Whether a Syra-hosted episode can be played via the encrypted HLS ladder.
   * External (rss) episodes and processing/guest cases use the progressive proxy.
   */
  const episodeSupportsHls = (episode: Episode): boolean =>
    episode.source === 'syra' &&
    episode.status === 'ready' &&
    Boolean(episode.hlsMasterKey) &&
    Array.isArray(episode.hls) &&
    episode.hls.length > 0 &&
    oxyServices.hasValidToken();

  /** Public progressive (range-proxy) audio URL for an episode. */
  const episodeProgressiveUrl = (episodeId: string): string =>
    `${getApiOrigin()}/api/podcasts/episodes/${episodeId}/audio`;

  /**
   * Resolve a playable URL for an episode. Syra-hosted ready episodes use the
   * tokenized HLS stream (falling back to the progressive proxy if that fails);
   * everything else streams from the public `/audio` proxy.
   */
  const resolveEpisodeAudio = async (
    episode: Episode,
  ): Promise<{ url: string; resolution: StreamResolution | null }> => {
    if (episodeSupportsHls(episode)) {
      try {
        const resolution = await resolveEpisodeStream(episode.id);
        return { url: resolution.url, resolution };
      } catch (error) {
        logger.warn('Episode HLS resolve failed, using progressive proxy', { episodeId: episode.id, error });
      }
    }
    return { url: episodeProgressiveUrl(episode.id), resolution: null };
  };

  /**
   * Persist the current episode's playback position. Best-effort: requires a
   * valid session and never throws into the caller.
   */
  const saveEpisodeProgress = (options?: { completed?: boolean }): void => {
    const episode = get().currentEpisode;
    if (!episode || !oxyServices.hasValidToken()) {
      return;
    }

    const positionSec = finiteSeconds(get().currentTime);
    const durationSec = finiteSeconds(get().duration) || finiteSeconds(episode.duration);
    const completed =
      options?.completed ??
      (durationSec > 0 && positionSec >= durationSec - EPISODE_COMPLETE_THRESHOLD_SEC);

    void episodeService
      .saveProgress({
        episodeId: episode.id,
        positionSec,
        durationSec: durationSec > 0 ? durationSec : undefined,
        completed,
      })
      .catch((error) => {
        logger.warn('Failed to save episode progress', { episodeId: episode.id, error });
      });
  };

  const stopProgressSaves = (): void => {
    if (progressSaveInterval) {
      clearInterval(progressSaveInterval);
      progressSaveInterval = null;
    }
  };

  const startProgressSaves = (): void => {
    stopProgressSaves();
    progressSaveInterval = setInterval(() => {
      if (get().currentEpisode && get().isPlaying) {
        saveEpisodeProgress();
      }
    }, PROGRESS_SAVE_INTERVAL_MS);
  };

  /**
   * Advance to the next episode in the sequential queue when one finishes, or
   * stop when the queue is exhausted. Marks the finished episode completed.
   */
  const handleEpisodeCompletion = async (): Promise<void> => {
    if (completionInFlight) {
      return;
    }
    completionInFlight = true;

    saveEpisodeProgress({ completed: true });

    const { episodeQueue, episodeIndex, context } = get();
    const nextIndex = episodeIndex + 1;

    if (nextIndex >= 0 && nextIndex < episodeQueue.length) {
      try {
        await get().playEpisode(episodeQueue[nextIndex], {
          queue: episodeQueue,
          index: nextIndex,
          context: context ?? undefined,
        });
      } finally {
        completionInFlight = false;
      }
      return;
    }

    await get().stop();
    completionInFlight = false;
  };

  // ── Cast output handoff ─────────────────────────────────────────────────────

  /**
   * Re-route the currently playing media to the now-active output (local ⇄ cast)
   * at the preserved position, keeping the queue and engagement tracking intact.
   * Invoked when a cast session connects or disconnects while something plays.
   *
   * The source URL is re-resolved through the same path `playTrack`/`playEpisode`
   * use (cheap — `streamService` memoizes), and `initializePlayer` picks the cast
   * or local engine based on the current `isCasting` flag.
   */
  const routePlaybackToActiveOutput = async (): Promise<void> => {
    const { currentTrack, currentEpisode, currentTime, isPlaying } = get();
    if (!currentTrack && !currentEpisode) {
      return;
    }

    const resumeFrom = finiteSeconds(currentTime);
    try {
      // Tear down the engine bound to the previous output. For a cast engine this
      // only detaches its listeners — the session stays open (see castService).
      stopPositionUpdates();
      stopProgressSaves();
      if (currentDetach) {
        currentDetach.detach();
        currentDetach = null;
      }
      const previousPlayer = get().player;
      if (previousPlayer) {
        previousPlayer.remove();
      }

      // Re-resolve the source and let initializePlayer pick the cast or local
      // engine based on the (already-updated) isCasting flag.
      let audioUrl: string;
      let resolution: StreamResolution | null;
      let media: PlayableMeta;
      if (currentEpisode) {
        const resolved = await resolveEpisodeAudio(currentEpisode);
        audioUrl = resolved.url;
        resolution = resolved.resolution;
        media = currentEpisode;
      } else if (currentTrack) {
        resolution = await getPhase3Resolution(currentTrack);
        audioUrl = resolution ? resolution.url : await getAudioUrl(currentTrack);
        media = currentTrack;
      } else {
        return;
      }

      const player = await initializePlayer(audioUrl, media, resolution);

      // hls.js attach only applies to the local web engine, never to cast.
      if (resolution && !get().isCasting) {
        currentDetach = attachSource(player, resolution);
      }
      if (currentEpisode) {
        applyPlaybackRate(player);
      }
      set({ player });

      if (resumeFrom > 0) {
        await player.seekTo(resumeFrom);
        set({ currentTime: resumeFrom });
      }
      if (isPlaying) {
        player.play();
      } else {
        player.pause();
      }
      if (currentEpisode) {
        applyPlaybackRate(player);
      }

      startPositionUpdates(player);
      if (currentEpisode) {
        startProgressSaves();
      }
    } catch (error) {
      logger.error('Failed to re-route playback to the active output', error);
    }
  };

  /**
   * React to cast session-state changes: mirror the casting flag/device name into
   * the store and, on an actual output switch (connect/disconnect), hand the
   * current media over to the now-active output. Native device-name resolution
   * re-fires `'connected'`, so the handoff only runs on a real casting transition.
   */
  const handleCastStateChange = (state: CastSessionState): void => {
    const isCasting = state === 'connected';
    const wasCasting = get().isCasting;
    set({
      isCasting,
      castDeviceName: isCasting ? castController.getDeviceName() : null,
    });
    if (isCasting === wasCasting) {
      return;
    }
    void routePlaybackToActiveOutput();
  };

  // Subscribe once at store creation. The controllers guard for SDK-not-ready /
  // native-module-absent, so this is a safe no-op until a receiver is available.
  castController.onSessionStateChange(handleCastStateChange);

  return {
    currentTrack: null,
    currentEpisode: null,
    episodeQueue: [],
    episodeIndex: 0,
    playbackRate: DEFAULT_PLAYBACK_RATE,
    isPlaying: false,
    isLoading: false,
    currentTime: 0,
    duration: 0,
    volume: DEFAULT_VOLUME,
    player: null,
    error: null,
    context: null,
    isCasting: castController.getSessionState() === 'connected',
    castDeviceName:
      castController.getSessionState() === 'connected' ? castController.getDeviceName() : null,
    connectActiveDeviceId: null,

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
          currentEpisode: null,
          episodeQueue: [],
          episodeIndex: 0,
          playbackRate: DEFAULT_PLAYBACK_RATE,
          context: context || null,
        });

        // Resolve stream — Phase-3 HLS tracks use resolveStream;
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
        // The cast receiver loads the URL directly; attachSource is hls.js-only.
        if (resolution && !get().isCasting) {
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
      const queue = await seedLocalQueue(tracks, startIndex, context);
      if (!queue) {
        return;
      }

      prefetchQueueStreams(queue.tracks, queue.current, { includeCurrent: true });
      await get().playTrack(queue.tracks[queue.current], context ?? queue.context, false);
    },

    /**
     * Play a podcast episode.
     *
     * Reuses the shared engine/position machinery but runs its own sequential
     * episode queue (no shuffle), resumes from a saved position, applies the
     * current playback rate, and persists progress while playing.
     */
    playEpisode: async (episode: Episode, options?: PlayEpisodeOptions) => {
      try {
        logger.info('Playing episode', { episodeId: episode.id, title: episode.title });

        const { player: currentPlayer, stop } = get();
        if (currentPlayer) {
          await stop();
        }

        const nextQueue = options?.queue && options.queue.length > 0 ? options.queue : [episode];
        const requestedIndex = options?.index;
        const resolvedIndex =
          requestedIndex !== undefined && requestedIndex >= 0
            ? requestedIndex
            : nextQueue.findIndex((item) => item.id === episode.id);

        set({
          isLoading: true,
          error: null,
          currentTrack: null,
          currentEpisode: episode,
          episodeQueue: nextQueue,
          episodeIndex: resolvedIndex >= 0 ? resolvedIndex : 0,
          context: options?.context ?? { type: 'episode', id: episode.id, name: episode.podcastTitle },
          currentTime: 0,
          duration: episode.duration || 0,
        });

        const { url, resolution } = await resolveEpisodeAudio(episode);
        logger.debug('Episode audio resolved', { url, type: resolution?.type });

        const player = await initializePlayer(url, episode, resolution);

        if (currentDetach) {
          currentDetach.detach();
          currentDetach = null;
        }
        // The cast receiver loads the URL directly; attachSource is hls.js-only.
        if (resolution && !get().isCasting) {
          currentDetach = attachSource(player, resolution);
        }

        applyPlaybackRate(player);
        set({ player, isLoading: true });

        try {
          await startPlayback(player, episode);
          // Some engines reset rate on (re)load — re-apply once playing.
          applyPlaybackRate(player);

          const resumeFromSec = finiteSeconds(options?.resumeFromSec);
          if (resumeFromSec >= RESUME_MIN_SEC) {
            await player.seekTo(resumeFromSec);
            set({ currentTime: resumeFromSec });
          }

          startPositionUpdates(player);
          startProgressSaves();
        } catch (playError) {
          logger.error('Error during episode playback', playError);
          set({
            isPlaying: false,
            isLoading: false,
            error: playError instanceof Error ? playError.message : 'Failed to play episode',
          });
          throw playError;
        }
      } catch (error) {
        logger.error('Error playing episode', error);
        set({
          error: error instanceof Error ? error.message : 'Failed to play episode',
          isLoading: false,
          isPlaying: false,
        });
      }
    },

    /**
     * Play a sequential list of episodes starting at `startIndex`, optionally
     * resuming the first one from a saved position.
     */
    playEpisodeList: async (
      episodes: Episode[],
      startIndex: number = 0,
      context?: PlaybackContext,
      resumeFromSec?: number,
    ) => {
      const playable = episodes.filter((episode) => episode?.id);
      if (playable.length === 0) {
        return;
      }
      const clampedIndex = Math.max(0, Math.min(startIndex, playable.length - 1));
      await get().playEpisode(playable[clampedIndex], {
        queue: playable,
        index: clampedIndex,
        context,
        resumeFromSec,
      });
    },

    /**
     * Pause playback
     */
    pause: async () => {
      const { player } = get();
      if (player) {
        player.pause();
        set({ isPlaying: false });
        if (get().currentEpisode) {
          saveEpisodeProgress();
        }
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
        if (get().currentEpisode) {
          saveEpisodeProgress();
        }
        logger.debug('Seeked to position', { position });
      }
    },

    /**
     * Seek relative to the current position (podcast skip ±15s / ±30s).
     * Clamped to the playable range and persists progress for episodes.
     */
    skipBy: async (seconds: number) => {
      const { player, currentTime, duration } = get();
      if (!player) {
        return;
      }
      const upperBound = duration > 0 ? duration : currentTime + Math.max(seconds, 0);
      const target = Math.max(0, Math.min(currentTime + seconds, upperBound));
      await player.seekTo(target);
      set({ currentTime: target });
      if (get().currentEpisode) {
        saveEpisodeProgress();
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
     * Set the podcast playback speed (0.5×–3×). Applied to the live engine and
     * remembered so it sticks across episodes in the session.
     */
    setPlaybackRate: (rate: number) => {
      const clampedRate = Math.min(3, Math.max(0.5, rate));
      set({ playbackRate: clampedRate });
      get().player?.setPlaybackRate?.(clampedRate);
      logger.debug('Playback rate set', { rate: clampedRate });
    },

    /**
     * Stop playback and cleanup
     */
    stop: async () => {
      // Capture engagement for the play being torn down before state resets.
      flushPlaySignal();
      stopPositionUpdates();
      stopProgressSaves();
      // Persist the final episode position before the state is cleared.
      if (get().currentEpisode) {
        saveEpisodeProgress();
      }
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
        currentEpisode: null,
        episodeQueue: [],
        episodeIndex: 0,
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
      // Episode playback advances through its own sequential queue.
      if (get().currentEpisode) {
        const { episodeQueue, episodeIndex, context } = get();
        const next = episodeIndex + 1;
        if (next < episodeQueue.length) {
          await get().playEpisode(episodeQueue[next], {
            queue: episodeQueue,
            index: next,
            context: context ?? undefined,
          });
        }
        return;
      }

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
      const { currentTime } = get();

      // Episode playback steps back through its own sequential queue.
      if (get().currentEpisode) {
        if (currentTime > 3) {
          await get().seek(0);
          return;
        }
        const { episodeQueue, episodeIndex, context } = get();
        const previous = episodeIndex - 1;
        if (previous >= 0) {
          await get().playEpisode(episodeQueue[previous], {
            queue: episodeQueue,
            index: previous,
            context: context ?? undefined,
          });
        }
        return;
      }

      const queueStore = useQueueStore.getState();

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

    applyRemotePlaybackState: async (state, localDeviceId) => {
      const wasActiveHere =
        get().connectActiveDeviceId !== null && get().connectActiveDeviceId === localDeviceId;
      const isNowActiveHere = localDeviceId !== null && state.activeDeviceId === localDeviceId;
      set({ connectActiveDeviceId: state.activeDeviceId ?? null });

      if (isNowActiveHere) {
        try {
          if (!state.trackId) {
            if (get().player) await get().stop();
            return;
          }

          const needsFreshLoad =
            get().currentTrack?.id !== state.trackId || !get().player;
          if (needsFreshLoad) {
            const track = await musicService.getTrackById(state.trackId);
            await get().playTrack(track, undefined, false);
          }

          await get().seek(state.positionMs / 1000);
          if (state.isPlaying) {
            await get().resume();
          } else {
            await get().pause();
          }

          // Mirror the server-authoritative queue so this device's up-next matches
          // the session it just took over. getQueue() returns the queue itself
          // (QueueWithMetadata extends Queue), not a wrapper.
          const remoteQueue = await queueService.getQueue().catch(() => null);
          if (remoteQueue) {
            useQueueStore.getState().syncQueue(remoteQueue);
          }
        } catch (error) {
          logger.error('Failed to apply remote Connect playback state', error);
        }
      } else if (wasActiveHere) {
        // Playback moved to another device — release the local audio engine.
        if (get().player) {
          await get().stop();
        }
      }
    },
  };
});
