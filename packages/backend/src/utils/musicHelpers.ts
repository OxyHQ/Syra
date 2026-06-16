import mongoose from 'mongoose';
import { AlbumModel } from '../models/Album';

// ── Image helpers ─────────────────────────────────────────────────────────────

/** First external image URL from an images[] array, if present. */
function firstImageUrl(doc: unknown): string | undefined {
  if (doc === null || typeof doc !== 'object') return undefined;
  const images = (doc as { images?: unknown }).images;
  if (!Array.isArray(images)) return undefined;
  const first: unknown = images[0];
  const url =
    first !== null && typeof first === 'object' && 'url' in first
      ? (first as { url?: unknown }).url
      : undefined;
  return typeof url === 'string' && url.length > 0 ? url : undefined;
}

/** Convert a MongoDB ObjectId string to an /api/images/:id URL. */
const toImageUrl = (id: string): string => `/api/images/${id}`;

/**
 * API representation of a persisted document: the `_id` ObjectId is dropped and
 * replaced by a string `id`. Mongoose `Document` machinery is stripped at
 * runtime via `toObject()`; structurally this still satisfies the shared
 * domain types (e.g. `Track`, `Album`), whose `_id` is an optional string.
 */
export type ApiFormat<T> = Omit<T, '_id'> & { id: string };

/** Narrow to a Mongoose document that exposes `toObject()`. */
function isMongooseDoc(value: object): value is { toObject: () => Record<string, unknown> } {
  return typeof (value as { toObject?: unknown }).toObject === 'function';
}

/**
 * Convert MongoDB document to API format
 * Converts _id to id and ensures proper serialization
 */
export function toApiFormat<T extends { _id?: mongoose.Types.ObjectId | string }>(
  doc: T | null | undefined
): ApiFormat<T> | null {
  if (!doc) return null;

  // Handle both Mongoose documents and plain objects
  const docObj: Record<string, unknown> = isMongooseDoc(doc)
    ? doc.toObject()
    : { ...doc };
  const { _id, ...rest } = docObj;

  // Convert _id to id string
  let id: string;
  if (_id instanceof mongoose.Types.ObjectId) {
    id = _id.toString();
  } else if (_id) {
    id = String(_id);
  } else {
    id = '';
  }

  // Ensure timestamps are strings if they exist
  const result: Record<string, unknown> = {
    ...rest,
    id,
  };

  // Convert Date objects to ISO strings for timestamps
  if (result.createdAt instanceof Date) {
    result.createdAt = result.createdAt.toISOString();
  }
  if (result.updatedAt instanceof Date) {
    result.updatedAt = result.updatedAt.toISOString();
  }

  return result as ApiFormat<T>;
}

/**
 * Convert array of MongoDB documents to API format
 */
export function toApiFormatArray<T extends { _id?: mongoose.Types.ObjectId | string }>(
  docs: T[]
): ApiFormat<T>[] {
  return docs
    .map(doc => toApiFormat(doc))
    .filter((doc): doc is ApiFormat<T> => doc !== null);
}

/**
 * Format track with album cover fallback
 * If track doesn't have coverArt but has albumId, use album's coverArt
 * Converts coverArt ObjectId to /api/images/:id URL
 */
export async function formatTrackWithCoverArt(
  track: any,
  albumCache?: Map<string, any>
): Promise<any> {
  const formatted = toApiFormat(track);
  if (!formatted) return null;

  // If track has coverArt, convert ObjectId to URL
  if (formatted.coverArt) {
    formatted.coverArt = toImageUrl(formatted.coverArt);
    return formatted;
  }

  // If track has albumId but no coverArt, fetch album and use its coverArt
  if (formatted.albumId) {
    let album;
    
    // Check cache first
    if (albumCache && albumCache.has(formatted.albumId)) {
      album = albumCache.get(formatted.albumId);
    } else {
      // Fetch album from database
      try {
        album = await AlbumModel.findById(formatted.albumId).lean();
        if (albumCache) {
          albumCache.set(formatted.albumId, album);
        }
      } catch (error) {
        // If album fetch fails, return track without coverArt
        return formatted;
      }
    }

    if (album) {
      if (album.coverArt) {
        // Album has an ObjectId coverArt — convert to API URL (highest album priority)
        formatted.coverArt = toImageUrl(album.coverArt);
      } else {
        // Album has no ObjectId coverArt — try its external images[] (e.g. Audius album art)
        const u = firstImageUrl(album);
        if (u) formatted.coverArt = u;
      }
    }
  }

  // Last resort: use track's own external images[] (e.g. Audius CDN) when still no cover
  if (!formatted.coverArt) {
    const u = firstImageUrl(formatted);
    if (u) formatted.coverArt = u;
  }

  return formatted;
}

/**
 * Format array of tracks with album cover fallback
 * Uses caching to avoid fetching the same album multiple times
 */
export async function formatTracksWithCoverArt(tracks: any[]): Promise<any[]> {
  const albumCache = new Map<string, any>();
  const formattedTracks = await Promise.all(
    tracks.map(track => formatTrackWithCoverArt(track, albumCache))
  );
  return formattedTracks.filter(Boolean);
}

/**
 * Format album with coverArt URL conversion
 * Converts coverArt ObjectId to /api/images/:id URL
 */
export function formatAlbumWithCoverArt(album: any): any {
  const formatted = toApiFormat(album);
  if (!formatted) return null;

  // Convert coverArt ObjectId to URL
  if (formatted.coverArt) {
    formatted.coverArt = toImageUrl(formatted.coverArt);
  }

  // Fallback: use first external image URL (e.g. Audius CDN) when no ObjectId art
  if (!formatted.coverArt) {
    const u = firstImageUrl(formatted);
    if (u) formatted.coverArt = u;
  }

  return formatted;
}

/**
 * Format array of albums with coverArt URL conversion
 */
export function formatAlbumsWithCoverArt(albums: any[]): any[] {
  return albums.map(album => formatAlbumWithCoverArt(album)).filter(Boolean);
}

/**
 * Format playlist with coverArt URL conversion
 * Converts coverArt ObjectId to /api/images/:id URL
 */
export function formatPlaylistWithCoverArt(playlist: any): any {
  const formatted = toApiFormat(playlist);
  if (!formatted) return null;

  // Convert coverArt ObjectId to URL
  if (formatted.coverArt) {
    formatted.coverArt = toImageUrl(formatted.coverArt);
  }

  return formatted;
}

/**
 * Format array of playlists with coverArt URL conversion
 */
export function formatPlaylistsWithCoverArt(playlists: any[]): any[] {
  return playlists.map(playlist => formatPlaylistWithCoverArt(playlist)).filter(Boolean);
}

/**
 * Format artist with image URL conversion
 * Converts image ObjectId to /api/images/:id URL
 */
export function formatArtistWithImage(artist: any): any {
  const formatted = toApiFormat(artist);
  if (!formatted) return null;

  // Convert image ObjectId to URL
  if (formatted.image) {
    formatted.image = toImageUrl(formatted.image);
  }

  // Fallback: use first external image URL (e.g. Audius CDN) when no ObjectId image
  if (!formatted.image) {
    const u = firstImageUrl(formatted);
    if (u) formatted.image = u;
  }

  return formatted;
}

/**
 * Format array of artists with image URL conversion
 */
export function formatArtistsWithImage(artists: any[]): any[] {
  return artists.map(artist => formatArtistWithImage(artist)).filter(Boolean);
}

