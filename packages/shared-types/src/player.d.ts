/**
 * Player-related types for Syra music streaming app
 * Playback state, queue, now playing
 */
import { Track } from './track';
/**
 * Playback state
 */
export declare enum PlaybackState {
    PLAYING = "playing",
    PAUSED = "paused",
    STOPPED = "stopped",
    BUFFERING = "buffering",
    ERROR = "error"
}
/**
 * Repeat mode
 */
export declare enum RepeatMode {
    OFF = "off",
    ALL = "all",
    ONE = "one"
}
/**
 * Shuffle mode
 */
export type ShuffleMode = 'on' | 'off';
/**
 * Current playback position
 */
export interface PlaybackPosition {
    currentTime: number;
    duration: number;
    progress: number;
}
/**
 * Now playing - currently playing track with playback state
 */
export interface NowPlaying {
    track: Track;
    state: PlaybackState;
    position: PlaybackPosition;
    volume: number;
    shuffle: ShuffleMode;
    repeat: RepeatMode;
    context?: PlaybackContext;
}
/**
 * Playback context - where the track is playing from
 */
export interface PlaybackContext {
    type: 'album' | 'artist' | 'playlist' | 'library' | 'search' | 'track';
    id?: string;
    name?: string;
    uri?: string;
}
/**
 * Queue - list of tracks to play
 */
export interface Queue {
    current: number;
    tracks: Track[];
    context?: PlaybackContext;
}
/**
 * Queue with additional metadata
 */
export interface QueueWithMetadata extends Queue {
    previous: Track[];
    next: Track[];
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
    position: number;
}
/**
 * Play track request
 */
export interface PlayTrackRequest {
    trackId: string;
    context?: PlaybackContext;
    position?: number;
}
/**
 * Play queue request
 */
export interface PlayQueueRequest {
    queue: Queue;
    startIndex?: number;
}
/**
 * Add to queue request
 */
export interface AddToQueueRequest {
    trackIds: string[];
    position?: 'next' | 'last' | number;
}
/**
 * Remove from queue request
 */
export interface RemoveFromQueueRequest {
    trackIds: string[];
}
