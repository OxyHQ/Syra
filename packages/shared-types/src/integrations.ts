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

/** Minimal album data as returned by an external provider */
export interface ExternalAlbum {
  name: string;
  externalId: string;
  images?: TrackImage[];
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
  /** Direct network stream URL (Audius only) */
  streamUrl?: string;
  /** Download URL for CC tracks with a commercial-use license */
  downloadUrl?: string;
  /** CC license identifier; filter out NC licenses before import */
  license?: string;
}
