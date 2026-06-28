import { API_URL } from '@/config';

// Syra catalog images (artist/album/track cover art) are stored on the Syra
// backend, NOT in Oxy media. The backend serializes them as a relative
// `/api/images/:id` path; the studio turns that (or a bare ObjectId) into an
// absolute URL so `expo-image` can load it. Oxy avatars still go through the
// Bloom `ImageResolverProvider`; this resolver is only for catalog art.

const IMAGE_PATH_PREFIX = '/api/images/';
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

/** Origin that serves `/api/images/:id` (API_URL without the `/api` suffix). */
function getCatalogApiOrigin(): string {
  try {
    const url = new URL(API_URL);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return `${url.protocol}//${url.hostname}:3000`;
    }
    return url.origin;
  } catch {
    return 'http://localhost:3000';
  }
}

function apiImageUrl(pathOrId: string): string {
  const path = pathOrId.startsWith(IMAGE_PATH_PREFIX) ? pathOrId : `${IMAGE_PATH_PREFIX}${pathOrId}`;
  return `${getCatalogApiOrigin()}${path}`;
}

/**
 * Resolve a catalog image reference to a loadable absolute URL. Accepts a bare
 * MongoDB ObjectId, a relative `/api/images/:id` path, or an already-absolute
 * URL pointing at the catalog API. Returns undefined for anything else.
 */
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
