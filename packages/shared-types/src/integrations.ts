/**
 * External integration types for Syra music streaming app
 *
 * These types represent data shapes returned by external providers
 * (Audius, Creative Commons) before they are normalized into the
 * canonical catalog (Track / Artist / Album).
 */

import { CatalogSource, TrackImage } from './track';

/** Minimal artist data as returned by an external provider */
export interface ExternalArtist {
  name: string;
  externalId: string;
  images?: TrackImage[];
}

/** Popularity signals as exposed by an external provider */
export interface ExternalPopularity {
  /** Lifetime play count */
  playCount?: number;
  /** Number of favourites / saves */
  favoriteCount?: number;
  /** Number of reposts / shares */
  repostCount?: number;
}

/** Minimal album data as returned by an external provider */
export interface ExternalAlbum {
  name: string;
  externalId: string;
  images?: TrackImage[];
  /** Release date as an ISO 8601 string, if the provider exposes one */
  releaseDate?: string;
  /** Single genre label as exposed by the provider */
  genre?: string;
  /** Popularity signals (play/favorite/repost counts) */
  popularity?: ExternalPopularity;
  /** External identifiers of the album's member tracks, in track order */
  trackExternalIds?: string[];
}

/** Minimal playlist data as returned by an external provider */
export interface ExternalPlaylist {
  name: string;
  externalId: string;
  images?: TrackImage[];
  description?: string;
  /** Single genre label inferred from playlist tracks, if available */
  genre?: string;
  /** Popularity signals (play/favorite/repost counts) */
  popularity?: ExternalPopularity;
  /** External identifiers of the playlist's member tracks, in track order */
  trackExternalIds?: string[];
  /** Full member tracks fetched with the playlist, used to fill catalog gaps */
  tracks?: ExternalTrack[];
}

/** A track as returned by an external provider, prior to catalog normalization */
export interface ExternalTrack {
  /** Which provider this track originates from */
  provider: CatalogSource;
  externalId: string;
  title: string;
  artists: ExternalArtist[];
  album?: ExternalAlbum;
  durationSec: number;
  isrc?: string;
  images?: TrackImage[];
  /** Single genre label as exposed by the provider (e.g. Audius `genre`) */
  genre?: string;
  /** Mood label as exposed by the provider (e.g. Audius `mood`) */
  mood?: string;
  /** Free-form tags exposed by the provider */
  tags?: string[];
  /** Release date as an ISO 8601 string, if the provider exposes one */
  releaseDate?: string;
  /** Popularity signals (play/favorite/repost counts) */
  popularity?: ExternalPopularity;
  /** Direct network stream URL (Audius only) */
  streamUrl?: string;
  /** Download URL for CC tracks with a commercial-use license */
  downloadUrl?: string;
  /** CC license identifier; filter out NC licenses before import */
  license?: string;
}
