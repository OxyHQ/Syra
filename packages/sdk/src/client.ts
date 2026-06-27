import {
  trackSummarySchema,
  type TrackSummary,
  type CoverArtSizes,
  type ArtworkSize,
} from './schema';
import { SyraApiError } from './errors';

/** Default base URL of the public Syra API. */
export const DEFAULT_SYRA_BASE_URL = 'https://api.syra.fm';

export interface SyraClientOptions {
  /** Base URL of the Syra API. Defaults to {@link DEFAULT_SYRA_BASE_URL}. */
  baseURL?: string;
  /**
   * `fetch` implementation. Defaults to the global `fetch` (Node 18+, browsers,
   * React Native). Inject one (e.g. `node-fetch`) when no global is available.
   * This is the seam where an authenticated transport can be layered in later.
   */
  fetch?: typeof fetch;
}

export interface SearchTracksOptions {
  /** Maximum number of tracks to request from the API. */
  limit?: number;
}

/** Minimal shape from which artwork URLs can be derived. */
export interface ArtworkSource {
  coverArt?: string | null;
  coverArtSizes?: CoverArtSizes | null;
}

export interface SyraClient {
  /**
   * Search the public catalog for tracks. Results are validated against the
   * track-summary schema and filtered to those that expose a public preview.
   */
  searchTracks(query: string, options?: SearchTracksOptions): Promise<TrackSummary[]>;
  /** Fetch a single track by id, validated against the track-summary schema. */
  getTrack(id: string): Promise<TrackSummary>;
  /** Build the public 30s preview URL for a track at the given start offset. */
  previewUrl(id: string, startSec?: number): string;
  /**
   * Resolve an absolute artwork URL from a track / cover-art reference. Returns
   * `undefined` when no artwork can be derived.
   */
  artworkUrl(source: string | ArtworkSource, size?: ArtworkSize): string | undefined;
}

/** Order used to pick the best available artwork variant when none is named. */
const ARTWORK_FALLBACK_ORDER: ArtworkSize[] = [
  'original',
  'xxlarge',
  'xlarge',
  'large',
  'medium',
  'small',
];

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

interface SearchResponseShape {
  results?: { tracks?: unknown[] };
}

/**
 * Create a headless client for the public Syra API. Public reads only — there
 * is no authentication in this version.
 */
export function createSyraClient(options: SyraClientOptions = {}): SyraClient {
  const baseURL = (options.baseURL ?? DEFAULT_SYRA_BASE_URL).replace(/\/+$/, '');

  function resolveFetch(): typeof fetch {
    if (options.fetch) {
      return options.fetch;
    }
    const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof globalFetch === 'function') {
      return globalFetch.bind(globalThis);
    }
    throw new Error(
      '@syra.fm/sdk: no global fetch is available. Pass `fetch` in createSyraClient options, ' +
        'or run on Node 18+, a browser, or React Native.',
    );
  }

  async function getJson(path: string): Promise<unknown> {
    const doFetch = resolveFetch();
    const response = await doFetch(`${baseURL}${path}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new SyraApiError(
        response.status,
        `Syra API request failed: ${response.status} ${response.statusText} (${path})`,
      );
    }
    return response.json();
  }

  function resolveImageRef(ref: string | null | undefined): string | undefined {
    if (!ref) {
      return undefined;
    }
    if (/^https?:\/\//i.test(ref)) {
      return ref;
    }
    if (ref.startsWith('/api/images/')) {
      return `${baseURL}${ref}`;
    }
    if (OBJECT_ID_PATTERN.test(ref)) {
      return `${baseURL}/api/images/${ref}`;
    }
    return undefined;
  }

  return {
    async searchTracks(query, searchOptions = {}) {
      const params = new URLSearchParams({ q: query, category: 'tracks' });
      if (typeof searchOptions.limit === 'number') {
        params.set('limit', String(searchOptions.limit));
      }

      const json = (await getJson(`/api/search?${params.toString()}`)) as SearchResponseShape;
      const rawTracks = Array.isArray(json?.results?.tracks) ? json.results.tracks : [];

      const tracks: TrackSummary[] = [];
      for (const raw of rawTracks) {
        // A single malformed catalog row must not fail the whole search.
        const parsed = trackSummarySchema.safeParse(raw);
        if (parsed.success && parsed.data.previewAvailable === true) {
          tracks.push(parsed.data);
        }
      }
      return tracks;
    },

    async getTrack(id) {
      const json = await getJson(`/api/tracks/${encodeURIComponent(id)}`);
      return trackSummarySchema.parse(json);
    },

    previewUrl(id, startSec = 0) {
      const safeStart = Number.isFinite(startSec) ? Math.max(0, Math.trunc(startSec)) : 0;
      return `${baseURL}/api/preview/${encodeURIComponent(id)}.mp3?start=${safeStart}`;
    },

    artworkUrl(source, size) {
      if (typeof source === 'string') {
        return resolveImageRef(source);
      }

      if (size && source.coverArtSizes) {
        const resolved = resolveImageRef(source.coverArtSizes[size]?.url);
        if (resolved) {
          return resolved;
        }
      }

      const fromCoverArt = resolveImageRef(source.coverArt);
      if (fromCoverArt) {
        return fromCoverArt;
      }

      if (source.coverArtSizes) {
        for (const key of ARTWORK_FALLBACK_ORDER) {
          const resolved = resolveImageRef(source.coverArtSizes[key]?.url);
          if (resolved) {
            return resolved;
          }
        }
      }

      return undefined;
    },
  };
}
