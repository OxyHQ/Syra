import type {
  Album,
  Artist,
  CatalogImageSizes,
  CatalogImageVariant,
  Playlist,
  Track,
  TrackImage,
} from '@syra/shared-types';
import { API_URL } from '@/config';
import type { SearchResultWithPending } from '@/utils/searchUtils';

const IMAGE_PATH_PREFIX = '/api/images/';
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

function getCatalogApiOrigin(): string {
  try {
    const apiBaseUrlObj = new URL(API_URL);
    if (apiBaseUrlObj.hostname === 'localhost' || apiBaseUrlObj.hostname === '127.0.0.1') {
      return `${apiBaseUrlObj.protocol}//${apiBaseUrlObj.hostname}:4120`;
    }
    return apiBaseUrlObj.origin;
  } catch {
    return 'http://localhost:4120';
  }
}

function apiImageUrl(pathOrId: string): string {
  const path = pathOrId.startsWith(IMAGE_PATH_PREFIX)
    ? pathOrId
    : `${IMAGE_PATH_PREFIX}${pathOrId}`;
  return `${getCatalogApiOrigin()}${path}`;
}

/** Resolves an Oxy file id (and rendition) to a URL — Oxy's `assets.publicUrl`. */
export type CatalogFileResolver = (fileId: string, variant?: string) => string;

let catalogFileResolver: CatalogFileResolver | null = null;

/**
 * Install the Oxy file resolver catalogue artwork uses (`AppProviders`, from the
 * same `oxyServices` its Bloom `ImageResolverProvider` uses). Kept out of this
 * module's imports so the image helpers stay pure for every test that loads them.
 */
export function setCatalogFileResolver(resolver: CatalogFileResolver | null): void {
  catalogFileResolver = resolver;
}

/** The URL of an Oxy-stored catalogue image, or `undefined` before a resolver is installed. */
export function resolveCatalogFileUrl(fileId: string, variant?: string): string | undefined {
  return catalogFileResolver?.(fileId, variant);
}

export function resolveCatalogImageUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (OBJECT_ID_RE.test(trimmed) || trimmed.startsWith(IMAGE_PATH_PREFIX)) {
    return apiImageUrl(trimmed);
  }

  try {
    const url = new URL(trimmed);
    const apiOrigin = getCatalogApiOrigin();
    if (url.origin === apiOrigin && url.pathname.startsWith(IMAGE_PATH_PREFIX)) {
      return url.toString();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function normalizeCatalogImageSizes(
  sizes: CatalogImageSizes | null | undefined,
): CatalogImageSizes | undefined {
  if (!sizes) return undefined;

  const normalized: CatalogImageSizes = {};
  for (const [key, variant] of Object.entries(sizes) as Array<
    [keyof CatalogImageSizes, CatalogImageVariant | undefined]
  >) {
    if (!variant) continue;
    const url = resolveCatalogImageUrl(variant.url) ?? resolveCatalogImageUrl(variant.id);
    if (!url) continue;
    normalized[key] = { ...variant, url };
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeCatalogTrackImages(
  images: TrackImage[] | null | undefined,
): TrackImage[] | undefined {
  if (!Array.isArray(images)) return undefined;

  const normalized = images
    .map((image) => {
      const url = resolveCatalogImageUrl(image.url);
      return url ? { ...image, url } : null;
    })
    .filter((image): image is TrackImage => image !== null);

  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeTrackImages<T extends Track>(track: T): T {
  return {
    ...track,
    coverArt: resolveCatalogImageUrl(track.coverArt),
    coverArtSizes: normalizeCatalogImageSizes(track.coverArtSizes),
    images: normalizeCatalogTrackImages(track.images),
  };
}

export function normalizeAlbumImages<T extends Album>(album: T): T {
  return {
    ...album,
    coverArt: resolveCatalogImageUrl(album.coverArt) ?? '',
    coverArtSizes: normalizeCatalogImageSizes(album.coverArtSizes),
  };
}

export function normalizeArtistImages<T extends Artist>(artist: T): T {
  return {
    ...artist,
    image: resolveCatalogImageUrl(artist.image),
    imageSizes: normalizeCatalogImageSizes(artist.imageSizes),
    images: normalizeCatalogTrackImages(artist.images),
  };
}

export function normalizePlaylistImages<T extends Playlist>(playlist: T): T {
  return {
    ...playlist,
    coverArt: resolveCatalogImageUrl(playlist.coverArt),
    coverArtSizes: normalizeCatalogImageSizes(playlist.coverArtSizes),
  };
}

export function normalizeSearchImages<T extends SearchResultWithPending>(result: T): T {
  return {
    ...result,
    results: {
      ...result.results,
      tracks: (result.results.tracks ?? []).map(normalizeTrackImages),
      albums: (result.results.albums ?? []).map(normalizeAlbumImages),
      artists: (result.results.artists ?? []).map(normalizeArtistImages),
      playlists: (result.results.playlists ?? []).map(normalizePlaylistImages),
    },
  };
}
