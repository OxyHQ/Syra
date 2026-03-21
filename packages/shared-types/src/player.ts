/**
 * Player-related types for Syra music streaming app
 * Playback state, queue, now playing
 */

import { Track } from './track';

/**
 * Playback state
 */
export enum PlaybackState {
  PLAYING = 'playing',
  PAUSED = 'paused',
  STOPPED = 'stopped',
  BUFFERING = 'buffering',
  ERROR = 'error'
}

/**
 * Repeat mode
 */
export enum RepeatMode {
  OFF = 'off',
  ALL = 'all',
  ONE = 'one'
}

/**
 * Shuffle mode
 */
export type ShuffleMode = 'on' | 'off';

/**
 * Current playback position
 */
export interface PlaybackPosition {
  currentTime: number; // in seconds
  duration: number; // in seconds
  progress: number; // 0-1
}

/**
 * Now playing - currently playing track with playback state
 */
export interface NowPlaying {
  track: Track;
  state: PlaybackState;
  position: PlaybackPosition;
  volume: number; // 0-1
  shuffle: ShuffleMode;
  repeat: RepeatMode;
  context?: PlaybackContext;
}

/**
 * Playback context - where the track is playing from
 */
export interface PlaybackContext {
  type: 'album' | 'artist' | 'playlist' | 'library' | 'search' | 'track';
  id?: string; // context ID (album ID, playlist ID, etc.)
  name?: string; // context name
  uri?: string; // context URI
}

/**
 * Queue - list of tracks to play
 */
export interface Queue {
  current: number; // index of currently playing track
  tracks: Track[];
  context?: PlaybackContext;
}

/**
 * Queue with additional metadata
 */
export interface QueueWithMetadata extends Queue {
  previous: Track[]; // previously played tracks
  next: Track[]; // upcoming tracks
  total: number;
}

/**
 * Playback state update
 */
export interface PlaybackStateUpdate {
  state?: PlaybackState;
  position?: PlaybackPosition;
  volume?: number;
  shuffle?: ShuffleMode;
  repeat?: RepeatMode;
}

/**
 * Seek request
 */
export interface SeekRequest {
  position: number; // position in seconds
}

/**
 * Play track request
 */
export interface PlayTrackRequest {
  trackId: string;
  context?: PlaybackContext;
  position?: number; // start position in seconds
}

/**
 * Play queue request
 */
export interface PlayQueueRequest {
  queue: Queue;
  startIndex?: number; // index to start playing from
}

/**
 * Add to queue request
 */
export interface AddToQueueRequest {
  trackIds: string[];
  position?: 'next' | 'last' | number; // where to add in queue
}

/**
 * Remove from queue request
 */
export interface RemoveFromQueueRequest {
  trackIds: string[];
}






