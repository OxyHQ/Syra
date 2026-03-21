/**
 * Playlist-related types for Syra music streaming app
 */
import { Timestamps } from './common';
import { Track } from './track';
/**
 * Playlist visibility
 */
export declare enum PlaylistVisibility {
    PUBLIC = "public",
    PRIVATE = "private",
    UNLISTED = "unlisted"
}
/**
 * Playlist collaborator
 */
export interface PlaylistCollaborator {
    oxyUserId: string;
    username: string;
    role: 'owner' | 'editor' | 'viewer';
    addedAt: string;
}
/**
 * Playlist - A collection of tracks curated by a user
 */
export interface Playlist extends Timestamps {
    id: string;
    _id?: string;
    name: string;
    description?: string;
    ownerOxyUserId: string;
    ownerUsername: string;
    coverArt?: string;
    visibility: PlaylistVisibility;
    trackCount: number;
    totalDuration: number;
    followers?: number;
    isPublic: boolean;
    primaryColor?: string;
    secondaryColor?: string;
    collaborators?: PlaylistCollaborator[];
}
/**
 * Playlist track reference
 */
export interface PlaylistTrack {
    trackId: string;
    addedAt: string;
    addedBy?: string;
    order: number;
}
/**
 * Playlist with tracks
 */
export interface PlaylistWithTracks extends Playlist {
    tracks: Track[];
    playlistTracks: PlaylistTrack[];
}
/**
 * Create playlist request
 */
export interface CreatePlaylistRequest {
    name: string;
    description?: string;
    coverArt?: string;
    visibility?: PlaylistVisibility;
    isPublic?: boolean;
}
/**
 * Update playlist request
 */
export interface UpdatePlaylistRequest {
    name?: string;
    description?: string;
    coverArt?: string;
    visibility?: PlaylistVisibility;
    isPublic?: boolean;
}
/**
 * Add tracks to playlist request
 */
export interface AddTracksToPlaylistRequest {
    playlistId: string;
    trackIds: string[];
    position?: number;
}
/**
 * Remove tracks from playlist request
 */
export interface RemoveTracksFromPlaylistRequest {
    playlistId: string;
    trackIds: string[];
}
/**
 * Reorder playlist tracks request
 */
export interface ReorderPlaylistTracksRequest {
    playlistId: string;
    trackIds: string[];
}
