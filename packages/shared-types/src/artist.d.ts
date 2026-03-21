/**
 * Artist-related types for Syra music streaming app
 */
import { Timestamps } from './common';
/**
 * Artist statistics
 */
export interface ArtistStats {
    followers: number;
    albums: number;
    tracks: number;
    totalPlays: number;
    monthlyListeners?: number;
}
/**
 * Strike information for an artist
 */
export interface ArtistStrike {
    _id?: string;
    reason: string;
    createdAt: string;
    trackId?: string;
}
/**
 * Artist - A music artist/band
 */
export interface Artist extends Timestamps {
    id: string;
    _id?: string;
    name: string;
    bio?: string;
    image?: string;
    genres?: string[];
    verified?: boolean;
    popularity?: number;
    primaryColor?: string;
    secondaryColor?: string;
    ownerOxyUserId?: string;
    stats: ArtistStats;
    strikeCount?: number;
    strikes?: ArtistStrike[];
    uploadsDisabled?: boolean;
    lastStrikeAt?: string;
}
/**
 * Artist with additional context for UI
 */
export interface ArtistWithContext extends Artist {
    isFollowed?: boolean;
}
/**
 * Create artist request
 */
export interface CreateArtistRequest {
    name: string;
    bio?: string;
    image?: string;
    genres?: string[];
    verified?: boolean;
}
/**
 * Update artist request
 */
export interface UpdateArtistRequest {
    name?: string;
    bio?: string;
    image?: string;
    genres?: string[];
    verified?: boolean;
}
/**
 * Follow/Unfollow artist request
 */
export interface FollowArtistRequest {
    artistId: string;
}
export interface UnfollowArtistRequest {
    artistId: string;
}
/**
 * Artist insights/analytics
 */
export interface ArtistInsights {
    totalPlays: number;
    monthlyListeners: number;
    followers: number;
    topTracks: Array<{
        trackId: string;
        title: string;
        playCount: number;
    }>;
    period?: '7days' | '30days' | 'alltime';
}
/**
 * Artist dashboard data
 */
export interface ArtistDashboard {
    artist: Artist;
    totalTracks: number;
    totalAlbums: number;
    totalPlays: number;
    followers: number;
    strikeCount: number;
    uploadsDisabled: boolean;
    recentTracks: Array<{
        id: string;
        title: string;
        createdAt: string;
        playCount: number;
    }>;
    recentAlbums: Array<{
        id: string;
        title: string;
        createdAt: string;
        totalTracks: number;
    }>;
    copyrightRemovedTracks: Array<{
        id: string;
        title: string;
        removedAt: string;
        removedReason?: string;
    }>;
}
