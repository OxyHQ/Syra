/**
 * Track-related types for Syra music streaming app
 */

import { Timestamps } from './common';

/** Which provider a catalog entity originates from */
export type CatalogSource = 'upload' | 'cc' | 'audius';

/** Lifecycle state of a track in the catalog */
export type TrackStatus = 'processing' | 'ready' | 'failed';

/** Cross-provider identifiers for a catalog entity */
export interface ExternalIds {
  isrc?: string;
  audiusId?: string;
}

/** Records which fields were imported from an external provider and when */
export interface SourceProvenance {
  provider: CatalogSource;
  externalId: string;
  importedAt: string;
  fields: string[];
}

/** An image asset from an external provider */
export interface TrackImage {
  url: string;
  width?: number;
  height?: number;
  source?: CatalogSource;
}

/** A single HLS rendition for adaptive streaming */
export interface HlsRendition {
  manifestKey: string;
  bitrateKbps: number;
  encrypted: boolean;
}

/**
 * Audio source for a track
 * URL format: /api/audio/{trackId} (uses MongoDB ObjectId)
 * Files are stored in S3 with structure: audio/{artistId}/{albumId}/{trackId}.{format}
 */
export interface AudioSource {
  url: string; // Format: /api/audio/{trackId}
  format: 'mp3' | 'flac' | 'ogg' | 'm4a' | 'wav';
  bitrate?: number; // in kbps
  duration?: number; // in seconds (can be calculated from file if not provided)
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
  isrc?: string; // International Standard Recording Code
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
  duration: number; // in seconds
  trackNumber?: number; // position in album
  discNumber?: number; // disc number for multi-disc albums
  /** Uploaded audio file; absent for audius stream-only and processing tracks */
  audioSource?: AudioSource;
  coverArt?: string; // MongoDB ObjectId string (24 hex characters) - image must be uploaded via /api/images/upload first. In API responses, converted to /api/images/:id URL
  metadata?: TrackMetadata;
  isExplicit: boolean;
  popularity?: number; // 0-100
  playCount?: number;
  isAvailable: boolean; // whether track is available for playback
  copyrightRemoved?: boolean;
  removedAt?: string;
  removedReason?: string;
  removedBy?: string; // Oxy user ID who reported/removed
  copyrightReportId?: string;
  /** Which provider this track originates from */
  source: CatalogSource;
  /** Lifecycle state; 'ready' once audio is transcoded and available */
  status: TrackStatus;
  /** Cross-provider identifiers (ISRC, Audius ID, etc.) */
  externalIds?: ExternalIds;
  /** Provenance log — one entry per provider that contributed fields */
  sources?: SourceProvenance[];
  /** External image assets (Audius / CC); uploaded tracks use coverArt */
  images?: TrackImage[];
  /** HLS adaptive renditions generated after upload transcoding */
  hls?: HlsRendition[];
  /** EBU R128 integrated loudness in LUFS */
  loudnessLufs?: number;
  /** Direct network stream URL (Audius only) */
  streamUrl?: string;
}

/**
 * Track with additional context for UI
 */
export interface TrackWithContext extends Track {
  isLiked?: boolean;
  isInPlaylist?: boolean;
  playlists?: string[]; // playlist IDs containing this track
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
  coverArt?: string; // MongoDB ObjectId string (24 hex characters) - image must be uploaded via /api/images/upload first
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
  coverArt?: string; // MongoDB ObjectId string (24 hex characters) - image must be uploaded via /api/images/upload first
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
  coverArt?: string; // MongoDB ObjectId string (24 hex characters) - image must be uploaded via /api/images/upload first
  genre?: string[];
  isExplicit?: boolean;
  // Audio file will be sent as multipart/form-data
}

