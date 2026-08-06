import mongoose from 'mongoose';
import { AlbumModel } from '../models/Album';
import { isPreviewEligibleTrack } from './catalogVisibility';

// ── Image helpers ─────────────────────────────────────────────────────────────

/** Convert a MongoDB ObjectId string to an /api/images/:id URL. */
const toImageUrl = (id: string): string => `/api/images/${id}`;

function isMongoObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}

/** Resolve a stored image reference (S3 ObjectId or already-normalised path) to `/api/images/:id`. */
export function normalizeImageRef(value: unknown): string | undefined {
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
  /**
   * Suggested profile photos are server-only, and this is the mechanism that
   * actually holds on the catalog read path.
   *
   * `CatalogEntity.imageSuggestions` is declared `select: false`, which excludes
   * it from QUERIES — but `findOneArtistWithPlayableTracks` and every other
   * container helper use `aggregate()`, and an aggregation pipeline ignores
   * schema-level `select` entirely. `toApiFormat` then spreads the whole
   * document, so `GET /api/artists/:id` returned the suggestions to anybody who
   * asked (verified against the real handler, not reasoned about).
   *
   * A suggestion is a GUESS about what a real person looks like, taken from a
   * stranger's file or matched from Commons by name. It is only ever answerable
   * by the artist, through the claim flow, so it is deleted here — the one place
   * every catalog serializer funnels through.
   */
  delete formatted.imageSuggestions;
  /**
   * The audio content hash — server-only, and stripped here for the same reason,
   * one step ahead of the same failure.
   *
   * `Track.sha256` is `select: false`, and today that ALONE is what keeps it off
   * the wire: track reads are `find()` queries, so the projection applies. A
   * sweep proved how thin that is — removing the flag leaked it from eleven
   * handlers at once (`/tracks`, `/search`, `/browse`, charts, the home feed,
   * album and artist track lists), because `toApiFormat` spreads and `trackSchema`
   * having no `sha256` field does not constrain an untyped formatter.
   *
   * So the single point of failure is "no track read is ever an aggregation" —
   * which is not a property anyone can hold in their head, and `imageSuggestions`
   * is the proof of what happens when it lapses. Deleting it here costs nothing
   * and removes the dependency.
   *
   * `rawTags` is deliberately NOT listed: no catalog model has the field
   * (`UserUpload` and `ContributionAttestation` do, and neither passes through
   * these helpers), so a delete for it would be a line that can never fire.
   */
  delete formatted.sha256;
}

/**
 * API representation of a persisted document: the `_id` ObjectId is dropped and
 * replaced by a string `id`. Mongoose `Document` machinery is stripped at
 * runtime via `toObject()`; structurally this still satisfies the shared
 * domain types (e.g. `Track`, `Album`), whose `_id` is an optional string.
 */
export type ApiFormat<T> = Omit<T, '_id'> & { id: string };

/**
 * What these formatters can actually serialize: a Mongoose document, or a
 * `.lean()` projection of one, carrying `_id`.
 *
 * The parameter was `any[]`, and that is what let this whole family accept a
 * drizzle row and return `{"id":"", …}` from four live endpoints — every field
 * absent, `id` an empty string, `tsc` clean, no test red. `_id` is REQUIRED
 * here precisely because a drizzle row does not have one, so the same mistake
 * is now a compile error rather than an empty response.
 *
 * This is a guard on a module with a death date, not a type worth growing: the
 * Postgres side of every one of these functions is `db/catalog/serialize.ts` +
 * `db/catalog/hydrate.ts`, which name every field they return. New code goes
 * there. See `db/catalog/__tests__/recommendationDtos.test.ts`.
 */
export interface MongoCatalogDoc {
  _id: mongoose.Types.ObjectId | string;
}

/**
 * Reads off a serialized document, which is an open record once `_id` is the
 * only field its type guarantees.
 *
 * A value of the wrong type reads as absent rather than being coerced: these
 * feed `isPreviewEligibleTrack`, where a truthy non-boolean is exactly the shape
 * that made the Mongo and playback predicates disagree (`db/catalog/visibility.ts`
 * records the measurement). Failing closed is the same answer the Postgres side
 * gives, where the columns are `NOT NULL` booleans.
 */
function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The album fields the track cover-art fallback reads. */
interface AlbumCoverSource extends MongoCatalogDoc {
  coverArt?: unknown;
  coverArtSizes?: unknown;
}

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
export async function formatTrackWithCoverArt<T extends MongoCatalogDoc>(
  track: T,
  albumCache?: Map<string, AlbumCoverSource | null>
): Promise<any> {
  const formatted: Record<string, unknown> | null = toApiFormat<MongoCatalogDoc>(track);
  if (!formatted) return null;

  stripExternalCatalogFields(formatted);
  formatted.coverArtSizes = normalizeImageSizes(formatted.coverArtSizes);

  // A public 30s preview can be served iff the track is playable AND a clip is
  // regenerable (retained `audioSource` OR the track's own ready HLS). The SDK
  // derives the preview URL from this flag — we never persist or expose a raw one.
  formatted.previewAvailable = isPreviewEligibleTrack({
    isAvailable: asBoolean(formatted.isAvailable),
    copyrightRemoved: asBoolean(formatted.copyrightRemoved),
    status: asString(formatted.status),
    hlsMasterKey: asString(formatted.hlsMasterKey),
    hls: Array.isArray(formatted.hls) ? formatted.hls : undefined,
    audioSource: formatted.audioSource,
  });

  if (formatted.coverArt) {
    formatted.coverArt = normalizeImageRef(formatted.coverArt);
    return formatted;
  }

  // If track has albumId but no coverArt, fetch album and use its coverArt
  const albumId = asString(formatted.albumId);
  if (albumId) {
    let album: AlbumCoverSource | null | undefined;

    // Check cache first
    if (albumCache && albumCache.has(albumId)) {
      album = albumCache.get(albumId);
    } else {
      // Fetch album from database
      try {
        album = await AlbumModel.findById(albumId).lean();
        if (albumCache) {
          albumCache.set(albumId, album);
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
export async function formatTracksWithCoverArt<T extends MongoCatalogDoc>(tracks: T[]): Promise<any[]> {
  const albumCache = new Map<string, AlbumCoverSource | null>();
  const formattedTracks = await Promise.all(
    tracks.map(track => formatTrackWithCoverArt(track, albumCache))
  );
  return formattedTracks.filter(Boolean);
}

/**
 * Format album with coverArt URL conversion
 * Converts coverArt ObjectId to /api/images/:id URL
 */
export function formatAlbumWithCoverArt<T extends MongoCatalogDoc>(album: T): any {
  const formatted: Record<string, unknown> | null = toApiFormat<MongoCatalogDoc>(album);
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
export function formatAlbumsWithCoverArt<T extends MongoCatalogDoc>(albums: T[]): any[] {
  return albums.map(album => formatAlbumWithCoverArt(album)).filter(Boolean);
}

/**
 * Format playlist with coverArt URL conversion
 * Converts coverArt ObjectId to /api/images/:id URL
 */
export function formatPlaylistWithCoverArt<T extends MongoCatalogDoc>(playlist: T): any {
  const formatted: Record<string, unknown> | null = toApiFormat<MongoCatalogDoc>(playlist);
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
export function formatPlaylistsWithCoverArt<T extends MongoCatalogDoc>(playlists: T[]): any[] {
  return playlists.map(playlist => formatPlaylistWithCoverArt(playlist)).filter(Boolean);
}

/**
 * Format artist with image URL conversion
 * Converts image ObjectId to /api/images/:id URL
 */
export function formatArtistWithImage<T extends MongoCatalogDoc>(artist: T): any {
  const formatted: Record<string, unknown> | null = toApiFormat<MongoCatalogDoc>(artist);
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
export function formatArtistsWithImage<T extends MongoCatalogDoc>(artists: T[]): any[] {
  return artists.map(artist => formatArtistWithImage(artist)).filter(Boolean);
}
