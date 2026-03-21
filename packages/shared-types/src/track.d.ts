/**
 * Track-related types for Syra music streaming app
 */
import { Timestamps } from './common';
/**
 * Audio source for a track
 * URL format: /api/audio/{trackId} (uses MongoDB ObjectId)
 * Files are stored in S3 with structure: audio/{artistId}/{albumId}/{trackId}.{format}
 */
export interface AudioSource {
    url: string;
    format: 'mp3' | 'flac' | 'ogg' | 'm4a' | 'wav';
    bitrate?: number;
    duration?: number;
}
/**
 * Track metadata
 */
export interface TrackMetadata {
    genre?: string[];
    bpm?: number;
    key?: string;
    explicit?: boolean;
    language?: string;
    isrc?: string;
    copyright?: string;
    publisher?: string;
}
/**
 * Track - A single song/audio recording
 */
export interface Track extends Timestamps {
    id: string;
    _id?: string;
    title: string;
    artistId: string;
    artistName: string;
    albumId?: string;
    albumName?: string;
    duration: number;
    trackNumber?: number;
    discNumber?: number;
    audioSource: AudioSource;
    coverArt?: string;
    metadata?: TrackMetadata;
    isExplicit: boolean;
    popularity?: number;
    playCount?: number;
    isAvailable: boolean;
    copyrightRemoved?: boolean;
    removedAt?: string;
    removedReason?: string;
    removedBy?: string;
    copyrightReportId?: string;
}
/**
 * Track with additional context for UI
 */
export interface TrackWithContext extends Track {
    isLiked?: boolean;
    isInPlaylist?: boolean;
    playlists?: string[];
}
/**
 * Create track request
 */
export interface CreateTrackRequest {
    title: string;
    artistId: string;
    albumId?: string;
    duration: number;
    audioSource: AudioSource;
    coverArt?: string;
    metadata?: TrackMetadata;
    isExplicit?: boolean;
}
/**
 * Update track request
 */
export interface UpdateTrackRequest {
    title?: string;
    albumId?: string;
    trackNumber?: number;
    discNumber?: number;
    coverArt?: string;
    metadata?: Partial<TrackMetadata>;
    isAvailable?: boolean;
}
/**
 * Upload track request (for file uploads)
 */
export interface UploadTrackRequest {
    title: string;
    artistId: string;
    albumId?: string;
    coverArt?: string;
    genre?: string[];
    isExplicit?: boolean;
}
