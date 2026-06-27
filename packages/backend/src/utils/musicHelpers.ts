import mongoose from 'mongoose';
import { AlbumModel } from '../models/Album';
import { isPreviewEligibleTrack } from './catalogVisibility';

// ── Image helpers ─────────────────────────────────────────────────────────────

/** Convert a MongoDB ObjectId string to an /api/images/:id URL. */
const toImageUrl = (id: string): string => `/api/images/${id}`;

function isMongoObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}

function normalizeImageRef(value: unknown): string | undefined {
  if (isMongoObjectId(value)) return toImageUrl(value);
  if (typeof value === 'string' && value.startsWith('/api/images/')) return value;
  return undefined;
}

function normalizeImageSizes(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const sizes = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, variantValue] of Object.entries(sizes)) {
    if (variantValue === null || typeof variantValue !== 'object') continue;
    const variant = { ...(variantValue as Record<string, unknown>) };
    const id = typeof variant.id === 'string' ? variant.id : undefined;
    const url = normalizeImageRef(variant.url) ?? (id ? normalizeImageRef(id) : undefined);
    if (!id || !url) continue;
    normalized[key] = { ...variant, url };
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function stripExternalCatalogFields(formatted: Record<string, unknown>): void {
  delete formatted.images;
  delete formatted.streamUrl;
}

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

  stripExternalCatalogFields(formatted);
  formatted.coverArtSizes = normalizeImageSizes(formatted.coverArtSizes);

  // A public 30s preview can be served iff the track is guest-playable AND a
  // clip is regenerable from a Syra-native source (retained `audioSource` OR the
  // track's own ready HLS — e.g. Audius rehosted to Syra HLS). The SDK derives
  // the preview URL from this flag — we never persist or expose a raw preview URL.
  formatted.previewAvailable = isPreviewEligibleTrack({
    isAvailable: formatted.isAvailable,
    source: formatted.source,
    status: formatted.status,
    hlsMasterKey: formatted.hlsMasterKey,
    hls: formatted.hls,
    audioSource: formatted.audioSource,
  });

  if (formatted.coverArt) {
    formatted.coverArt = normalizeImageRef(formatted.coverArt);
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
        formatted.coverArt = normalizeImageRef(album.coverArt);
      }
      if (!formatted.coverArtSizes && album.coverArtSizes) {
        formatted.coverArtSizes = normalizeImageSizes(album.coverArtSizes);
      }
    }
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

  stripExternalCatalogFields(formatted);
  formatted.coverArtSizes = normalizeImageSizes(formatted.coverArtSizes);
  if (formatted.coverArt) {
    formatted.coverArt = normalizeImageRef(formatted.coverArt);
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

  stripExternalCatalogFields(formatted);
  formatted.coverArtSizes = normalizeImageSizes(formatted.coverArtSizes);
  if (formatted.coverArt) {
    formatted.coverArt = normalizeImageRef(formatted.coverArt);
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

  stripExternalCatalogFields(formatted);
  formatted.imageSizes = normalizeImageSizes(formatted.imageSizes);
  if (formatted.image) {
    formatted.image = normalizeImageRef(formatted.image);
  }

  return formatted;
}

/**
 * Format array of artists with image URL conversion
 */
export function formatArtistsWithImage(artists: any[]): any[] {
  return artists.map(artist => formatArtistWithImage(artist)).filter(Boolean);
}
