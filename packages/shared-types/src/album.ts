/**
 * Album-related types for Syra music streaming app
 */

import { Timestamps } from './common';
import { Track, CatalogSource, ExternalIds, SourceProvenance } from './track';

/**
 * Album - A collection of tracks
 */
export interface Album extends Timestamps {
  id: string;
  _id?: string;
  title: string;
  artistId: string;
  artistName: string;
  releaseDate: string; // ISO date string
  coverArt: string; // MongoDB ObjectId string (24 hex characters) - image must be uploaded via /api/images/upload first // URL to album cover (stored as MongoDB ObjectId in DB, converted to /api/images/:id URL in API responses)
  genre?: string[];
  totalTracks: number;
  totalDuration: number; // total duration in seconds
  type: 'album' | 'single' | 'ep' | 'compilation';
  label?: string; // record label
  copyright?: string;
  upc?: string; // Universal Product Code
  popularity?: number; // 0-100
  /** Lifetime play count (provider-supplied popularity signal) */
  playCount?: number;
  /** Number of favourites / saves (provider-supplied popularity signal) */
  favoriteCount?: number;
  /** Number of reposts / shares (provider-supplied popularity signal) */
  repostCount?: number;
  isExplicit: boolean;
  primaryColor?: string; // Primary hex color extracted from cover art (e.g., "#FF5733")
  secondaryColor?: string; // Secondary hex color extracted from cover art (e.g., "#33FF57")
  /** Which provider this album record originates from */
  source?: CatalogSource;
  /** Cross-provider identifiers (ISRC, UPC, etc.) */
  externalIds?: ExternalIds;
  /** Provenance log — one entry per provider that contributed fields */
  sources?: SourceProvenance[];
}

/**
 * Album with tracks
 */
export interface AlbumWithTracks extends Album {
  tracks: Track[];
}

/**
 * Album track reference (lightweight)
 */
export interface AlbumTrack {
  trackId: string;
  trackNumber: number;
  discNumber?: number;
  title: string;
  duration: number;
  isExplicit: boolean;
}

/**
 * Create album request
 */
export interface CreateAlbumRequest {
  title: string;
  artistId: string;
  releaseDate: string;
  coverArt: string; // MongoDB ObjectId string (24 hex characters) - image must be uploaded via /api/images/upload first
  genre?: string[];
  type?: 'album' | 'single' | 'ep' | 'compilation';
  label?: string;
  copyright?: string;
  isExplicit?: boolean;
}

/**
 * Update album request
 */
export interface UpdateAlbumRequest {
  title?: string;
  releaseDate?: string;
  coverArt?: string;
  genre?: string[];
  type?: 'album' | 'single' | 'ep' | 'compilation';
  label?: string;
  copyright?: string;
}

