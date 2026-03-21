/**
 * Playlist-related types for Syra music streaming app
 */

import { Timestamps } from './common';
import { Track } from './track';

/**
 * Playlist visibility
 */
export enum PlaylistVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
  UNLISTED = 'unlisted' // accessible via link but not searchable
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
  coverArt?: string; // MongoDB ObjectId string (24 hex characters) - image must be uploaded via /api/images/upload first // MongoDB ObjectId string (24 hex characters) - image must be uploaded via /api/images/upload first. In API responses, converted to /api/images/:id URL
  visibility: PlaylistVisibility;
  trackCount: number;
  totalDuration: number; // total duration in seconds
  followers?: number;
  isPublic: boolean;
  primaryColor?: string; // Primary hex color extracted from cover art (e.g., "#FF5733")
  secondaryColor?: string; // Secondary hex color extracted from cover art (e.g., "#33FF57")
  collaborators?: PlaylistCollaborator[];
}

/**
 * Playlist track reference
 */
export interface PlaylistTrack {
  trackId: string;
  addedAt: string;
  addedBy?: string; // oxyUserId who added the track
  order: number; // position in playlist
}

/**
 * Playlist with tracks
 */
export interface PlaylistWithTracks extends Playlist {
  tracks: Track[];
  playlistTracks: PlaylistTrack[]; // tracks with metadata about their position in playlist
}

/**
 * Create playlist request
 */
export interface CreatePlaylistRequest {
  name: string;
  description?: string;
  coverArt?: string; // MongoDB ObjectId string (24 hex characters) - image must be uploaded via /api/images/upload first
  visibility?: PlaylistVisibility;
  isPublic?: boolean;
}

/**
 * Update playlist request
 */
export interface UpdatePlaylistRequest {
  name?: string;
  description?: string;
  coverArt?: string; // MongoDB ObjectId string (24 hex characters) - image must be uploaded via /api/images/upload first
  visibility?: PlaylistVisibility;
  isPublic?: boolean;
}

/**
 * Add tracks to playlist request
 */
export interface AddTracksToPlaylistRequest {
  playlistId: string;
  trackIds: string[];
  position?: number; // insert at specific position, or append to end
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
  trackIds: string[]; // new order of track IDs
}

