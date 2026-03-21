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
import { createAudioPlayer, AudioPlayer } from 'expo-audio';
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
  extractTrackIdFromUrl,
  fetchAuthenticatedAudioUrl,
  resolveAudioUrlWithFallback,
  calculateTrackDuration,
  clampVolume,
} from './playerStore.helpers';

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
  player: AudioPlayer | null;
  error: string | null;
  context: PlaybackContext | null;
  
  // Actions
  playTrack: (track: Track, context?: PlaybackContext, addToQueue?: boolean) => Promise<void>;
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

  /**
   * Start position update interval
   * Updates player position, duration, and playing state at regular intervals
   */
  const startPositionUpdates = (player: AudioPlayer) => {
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
  const setupPlayerListeners = (player: AudioPlayer) => {
    player.addListener('playbackStatusUpdate', (status) => {
      if (status.isLoaded) {
        if (status.didJustFinish) {
          logger.debug('Track finished, handling completion');
          get().handleTrackCompletion();
        } else {
          set({
            isPlaying: status.playing || false,
            currentTime: status.currentTime || 0,
            duration: status.duration || get().duration,
          });
        }
      }
    });
  };

  /**
   * Update queue state after track starts playing
   */
  const updateQueueState = async (track: Track, addToQueue: boolean) => {
    const queueStore = useQueueStore.getState();
    
    if (addToQueue) {
      await queueStore.addToQueue([track.id], 'last');
    } else {
      const queue = queueStore.queue;
      if (queue) {
        const trackIndex = queue.tracks.findIndex(t => t.id === track.id);
        if (trackIndex >= 0) {
          await queueStore.setCurrentIndex(trackIndex);
        }
      }
    }
  };

  /**
   * Initialize audio player with URL
   */
  const initializePlayer = async (audioUrl: string, track: Track): Promise<AudioPlayer> => {
    logger.debug('Initializing audio player', { url: audioUrl, trackId: track.id });
    
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
  const startPlayback = async (player: AudioPlayer, track: Track): Promise<void> => {
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
   * Get authenticated audio URL with fallback
   */
  const getAudioUrl = async (track: Track): Promise<string> => {
    const trackId = extractTrackIdFromUrl(track.audioSource.url, track.id);
    
    try {
      logger.debug('Fetching authenticated audio URL', { trackId });
      const url = await fetchAuthenticatedAudioUrl(trackId);
      logger.debug('Successfully fetched authenticated URL');
      return url;
    } catch (error) {
      logger.warn('Failed to fetch authenticated URL, using fallback', { error, trackId });
      return resolveAudioUrlWithFallback(track);
    }
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
          url: track.audioSource.url 
        });
        
        set({ 
          isLoading: true, 
          error: null, 
          currentTrack: track,
          context: context || null,
        });

        // Stop current track if playing
        const { player: currentPlayer, stop } = get();
        if (currentPlayer) {
          await stop();
        }

        // Get authenticated audio URL
        const audioUrl = await getAudioUrl(track);
        logger.debug('Audio URL resolved', { url: audioUrl });

        // Initialize and start player
        const player = await initializePlayer(audioUrl, track);
        
        set({ 
          player,
          isLoading: true,
          currentTime: 0,
          duration: track.duration || 0,
        });

        try {
          await startPlayback(player, track);
          await updateQueueState(track, addToQueue);
          startPositionUpdates(player);
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
      stopPositionUpdates();
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
      const queueStore = useQueueStore.getState();
      await queueStore.playNext();
      
      const queue = queueStore.queue;
      if (queue && queue.current >= 0 && queue.current < queue.tracks.length) {
        const nextTrack = queue.tracks[queue.current];
        await get().playTrack(nextTrack, queue.context, false);
      }
    },

    /**
     * Play previous track in queue
     */
    playPrevious: async () => {
      const queueStore = useQueueStore.getState();
      await queueStore.playPrevious();
      
      const queue = queueStore.queue;
      if (queue && queue.current >= 0 && queue.current < queue.tracks.length) {
        const prevTrack = queue.tracks[queue.current];
        await get().playTrack(prevTrack, queue.context, false);
      }
    },

    /**
     * Handle track completion
     * Automatically plays next track based on repeat mode
     */
    handleTrackCompletion: async () => {
      const queueStore = useQueueStore.getState();
      const queue = queueStore.queue;
      const { repeat } = queueStore;

      await get().stop();

      if (!queue || queue.tracks.length === 0) {
        return;
      }

      const currentIndex = queue.current;
      
      // Handle repeat one mode
      if (repeat === RepeatMode.ONE) {
        if (currentIndex >= 0 && currentIndex < queue.tracks.length) {
          const track = queue.tracks[currentIndex];
          await get().playTrack(track, queue.context, false);
        }
        return;
      }

      // Handle next track or repeat all
      const nextIndex = currentIndex + 1;
      if (nextIndex < queue.tracks.length) {
        await get().playFromQueue(nextIndex);
      } else if (repeat === RepeatMode.ALL) {
        await get().playFromQueue(0);
      }
    },
  };
});
