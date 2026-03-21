/**
 * Library-related types for Syra music streaming app
 * User's personal music library - liked songs, saved albums, followed artists
 */
import { Timestamps } from './common';
import { Track } from './track';
import { Album } from './album';
import { Artist } from './artist';
import { Playlist } from './playlist';
/**
 * User's music library
 */
export interface UserLibrary extends Timestamps {
    oxyUserId: string;
    likedTracks: string[];
    savedAlbums: string[];
    followedArtists: string[];
    playlists: string[];
}
/**
 * Liked tracks response
 */
export interface LikedTracks {
    tracks: Track[];
    total: number;
    oxyUserId: string;
}
/**
 * Saved albums response
 */
export interface SavedAlbums {
    albums: Album[];
    total: number;
    oxyUserId: string;
}
/**
 * Followed artists response
 */
export interface FollowedArtists {
    artists: Artist[];
    total: number;
    oxyUserId: string;
}
/**
 * User playlists response
 */
export interface UserPlaylists {
    playlists: Playlist[];
    total: number;
    oxyUserId: string;
}
/**
 * Like/Unlike track request
 */
export interface LikeTrackRequest {
    trackId: string;
}
export interface UnlikeTrackRequest {
    trackId: string;
}
/**
 * Save/Unsave album request
 */
export interface SaveAlbumRequest {
    albumId: string;
}
export interface UnsaveAlbumRequest {
    albumId: string;
}
