import {
  trackSummarySchema,
  podcastSummarySchema,
  episodeSummarySchema,
  type TrackSummary,
  type PodcastSummary,
  type EpisodeSummary,
  type CoverArtSizes,
  type ArtworkSize,
} from './schema';
import { SyraApiError } from './errors';

/** Default base URL of the public Syra API. */
export const DEFAULT_SYRA_BASE_URL = 'https://api.syra.fm';

/** Default base URL of the Syra web app, used for deep links. */
export const DEFAULT_SYRA_WEB_BASE_URL = 'https://syra.fm';

export interface SyraClientOptions {
  /** Base URL of the Syra API. Defaults to {@link DEFAULT_SYRA_BASE_URL}. */
  baseURL?: string;
  /**
   * Base URL of the Syra WEB app (not the API host), used to build deep links
   * such as {@link SyraClient.podcastUrl}. Defaults to
   * {@link DEFAULT_SYRA_WEB_BASE_URL}.
   */
  webBaseURL?: string;
  /**
   * `fetch` implementation. Defaults to the global `fetch` (Node 18+, browsers,
   * React Native). Inject one (e.g. `node-fetch`) when no global is available.
   * This is the seam where an authenticated transport can be layered in later.
   */
  fetch?: typeof fetch;
}

export interface SearchTracksOptions {
  /** Maximum number of tracks to request from the API (the page size). */
  limit?: number;
  /** Zero-based offset of the first track to return (for infinite scroll). */
  offset?: number;
}

export interface SearchPodcastsOptions {
  /** Maximum number of podcast shows to request from the API (the page size). */
  limit?: number;
  /** Zero-based offset of the first show to return (for infinite scroll). */
  offset?: number;
}

export interface PodcastEpisodesOptions {
  /** Maximum number of episodes to request from the API (the page size). */
  limit?: number;
  /** Zero-based offset of the first episode to return (for infinite scroll). */
  offset?: number;
}

/**
 * One page of paginated catalog search results.
 *
 * `hasMore` reflects the BACKEND's pagination over the full matching set — NOT
 * `items.length`. {@link SyraClient.searchTracks} additionally filters its page
 * client-side to preview-available tracks, so `items.length` can be smaller than
 * `limit` while `hasMore` is still `true`; callers must paginate by advancing
 * `offset` by `limit` (the page size), never by `items.length`.
 */
export interface SearchPage<T> {
  /** The validated rows for this page. */
  items: T[];
  /** Whether the backend has results beyond this page. */
  hasMore: boolean;
  /** The page size the backend applied. */
  limit: number;
  /** The zero-based offset of this page. */
  offset: number;
}

/** Minimal shape from which track artwork URLs can be derived. */
export interface ArtworkSource {
  coverArt?: string | null;
  coverArtSizes?: CoverArtSizes | null;
}

/** Minimal shape from which podcast-show artwork URLs can be derived. */
export interface PodcastArtworkSource {
  image?: string | null;
  imageSizes?: CoverArtSizes | null;
  imageSourceUrl?: string | null;
}

/** Minimal shape from which podcast-episode artwork URLs can be derived. */
export interface EpisodeArtworkSource {
  image?: string | null;
  imageSizes?: CoverArtSizes | null;
  imageSourceUrl?: string | null;
}

export interface SyraClient {
  /**
   * Search the public catalog for tracks. Returns one paginated page: rows are
   * validated against the track-summary schema and filtered to those that expose
   * a public preview. `hasMore` comes from the backend's pagination, so it is
   * unaffected by the client-side preview filter (see {@link SearchPage}).
   */
  searchTracks(query: string, options?: SearchTracksOptions): Promise<SearchPage<TrackSummary>>;
  /** Fetch a single track by id, validated against the track-summary schema. */
  getTrack(id: string): Promise<TrackSummary>;
  /** Build the public 30s preview URL for a track at the given start offset. */
  previewUrl(id: string, startSec?: number): string;
  /**
   * Resolve an absolute artwork URL from a track / cover-art reference. Returns
   * `undefined` when no artwork can be derived.
   */
  artworkUrl(source: string | ArtworkSource, size?: ArtworkSize): string | undefined;
  /**
   * Search the public catalog for podcast SHOWS (not episodes). Returns one
   * paginated page: rows are validated against the podcast-summary schema and
   * malformed rows are dropped. `hasMore` comes from the backend's pagination.
   */
  searchPodcasts(query: string, options?: SearchPodcastsOptions): Promise<SearchPage<PodcastSummary>>;
  /**
   * Fetch a single podcast show by id, validated against the podcast-summary
   * schema. The by-id endpoint also returns episodes and resolved persons; this
   * returns just the show summary needed to render a card.
   */
  getPodcast(id: string): Promise<PodcastSummary>;
  /** Build the Syra web app deep link for a podcast show (`/podcasts/:id`). */
  podcastUrl(id: string): string;
  /**
   * Resolve an absolute artwork URL from a podcast show reference. Prefers the
   * re-hosted Syra image, then the requested/fallback variant, then the original
   * external artwork URL. Returns `undefined` when no artwork can be derived.
   */
  podcastArtworkUrl(source: PodcastArtworkSource, size?: ArtworkSize): string | undefined;
  /**
   * List a podcast show's EPISODES (newest first, as the backend orders them).
   * Returns one paginated page: rows are validated against the episode-summary
   * schema and malformed rows are dropped — including any without a playable
   * `enclosureUrl`, which the schema requires. The backend paginates by 1-based
   * `page`, but this keeps the uniform offset-based {@link SearchPage} for parity
   * with {@link SyraClient.searchPodcasts}; paginate by advancing `offset` by
   * `limit` (the page size), never by `items.length`.
   */
  getPodcastEpisodes(
    podcastId: string,
    options?: PodcastEpisodesOptions,
  ): Promise<SearchPage<EpisodeSummary>>;
  /**
   * Fetch a single episode by id, validated against the episode-summary schema.
   * The by-id endpoint nests the episode under `data.episode` alongside resolved
   * persons; this returns just the episode summary needed to stream its audio.
   */
  getEpisode(episodeId: string): Promise<EpisodeSummary>;
  /**
   * Resolve an absolute artwork URL from a podcast episode reference. Prefers the
   * re-hosted Syra image, then the requested/fallback variant, then the original
   * external artwork URL. Returns `undefined` when no artwork can be derived.
   */
  episodeImageUrl(source: EpisodeArtworkSource, size?: ArtworkSize): string | undefined;
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

/**
 * Default episode page size, matching the backend's own default so the SDK's
 * offset→page translation lines up with the server's pagination window.
 */
const DEFAULT_EPISODES_PAGE_SIZE = 20;

/** Read a finite number from an unknown response field, else a fallback. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

interface SearchResponseShape {
  results?: { tracks?: unknown[] };
  hasMore?: unknown;
  limit?: unknown;
  offset?: unknown;
}

interface PodcastSearchResponseShape {
  data?: unknown[];
  hasMore?: unknown;
  limit?: unknown;
  offset?: unknown;
}

interface PodcastDetailResponseShape {
  data?: { podcast?: unknown };
}

interface PodcastEpisodesResponseShape {
  data?: unknown[];
  total?: unknown;
  page?: unknown;
  limit?: unknown;
}

interface EpisodeDetailResponseShape {
  data?: { episode?: unknown };
}

/**
 * Create a headless client for the public Syra API. Public reads only — there
 * is no authentication in this version.
 */
export function createSyraClient(options: SyraClientOptions = {}): SyraClient {
  const baseURL = (options.baseURL ?? DEFAULT_SYRA_BASE_URL).replace(/\/+$/, '');
  const webBaseURL = (options.webBaseURL ?? DEFAULT_SYRA_WEB_BASE_URL).replace(/\/+$/, '');

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
      if (typeof searchOptions.offset === 'number') {
        params.set('offset', String(searchOptions.offset));
      }

      const json = (await getJson(`/api/search?${params.toString()}`)) as SearchResponseShape;
      const rawTracks = Array.isArray(json?.results?.tracks) ? json.results.tracks : [];

      const items: TrackSummary[] = [];
      for (const raw of rawTracks) {
        // A single malformed catalog row must not fail the whole search.
        const parsed = trackSummarySchema.safeParse(raw);
        if (parsed.success && parsed.data.previewAvailable === true) {
          items.push(parsed.data);
        }
      }

      return {
        items,
        // `hasMore` is sourced from the backend's pagination over the FULL result
        // set; the client-side preview filter above may shrink `items` below
        // `limit`, but must NOT corrupt `hasMore` (else a page whose tail was
        // filtered out would falsely report the end of the catalog).
        hasMore: json?.hasMore === true,
        limit: numberOr(json?.limit, searchOptions.limit ?? rawTracks.length),
        offset: numberOr(json?.offset, searchOptions.offset ?? 0),
      };
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

    async searchPodcasts(query, searchOptions = {}) {
      const params = new URLSearchParams({ q: query });
      if (typeof searchOptions.limit === 'number') {
        params.set('limit', String(searchOptions.limit));
      }
      if (typeof searchOptions.offset === 'number') {
        params.set('offset', String(searchOptions.offset));
      }

      const json = (await getJson(
        `/api/podcasts/search?${params.toString()}`,
      )) as PodcastSearchResponseShape;
      const rawPodcasts = Array.isArray(json?.data) ? json.data : [];

      const items: PodcastSummary[] = [];
      for (const raw of rawPodcasts) {
        // A single malformed catalog row must not fail the whole search.
        const parsed = podcastSummarySchema.safeParse(raw);
        if (parsed.success) {
          items.push(parsed.data);
        }
      }

      return {
        items,
        // `hasMore` reflects the backend's pagination over the full result set.
        hasMore: json?.hasMore === true,
        limit: numberOr(json?.limit, searchOptions.limit ?? rawPodcasts.length),
        offset: numberOr(json?.offset, searchOptions.offset ?? 0),
      };
    },

    async getPodcast(id) {
      const json = (await getJson(
        `/api/podcasts/${encodeURIComponent(id)}`,
      )) as PodcastDetailResponseShape;
      return podcastSummarySchema.parse(json?.data?.podcast);
    },

    podcastUrl(id) {
      return `${webBaseURL}/podcasts/${encodeURIComponent(id)}`;
    },

    podcastArtworkUrl(source, size) {
      if (size && source.imageSizes) {
        const resolved = resolveImageRef(source.imageSizes[size]?.url);
        if (resolved) {
          return resolved;
        }
      }

      const fromImage = resolveImageRef(source.image);
      if (fromImage) {
        return fromImage;
      }

      if (source.imageSizes) {
        for (const key of ARTWORK_FALLBACK_ORDER) {
          const resolved = resolveImageRef(source.imageSizes[key]?.url);
          if (resolved) {
            return resolved;
          }
        }
      }

      return resolveImageRef(source.imageSourceUrl);
    },

    async getPodcastEpisodes(podcastId, listOptions = {}) {
      // The endpoint paginates by 1-based `page`; translate the SDK's uniform
      // offset-based paging into it. `limit` must be concrete (unlike search,
      // which can omit it) because the page number is derived from it.
      const limit = listOptions.limit ?? DEFAULT_EPISODES_PAGE_SIZE;
      const offset = listOptions.offset ?? 0;
      const page = Math.floor(offset / limit) + 1;

      const json = (await getJson(
        `/api/podcasts/${encodeURIComponent(podcastId)}/episodes?page=${page}&limit=${limit}`,
      )) as PodcastEpisodesResponseShape;
      const rawEpisodes = Array.isArray(json?.data) ? json.data : [];

      const items: EpisodeSummary[] = [];
      for (const raw of rawEpisodes) {
        // A single malformed episode row must not fail the whole listing.
        const parsed = episodeSummarySchema.safeParse(raw);
        if (parsed.success) {
          items.push(parsed.data);
        }
      }

      // `total` is the backend's full count over the show; derive `hasMore` from
      // it rather than `items.length`, which the schema/enclosure filter above may
      // shrink below `limit` on a page that is NOT the last one. Absent a count,
      // fall back to what we have (this page ends the listing).
      const total = numberOr(json?.total, offset + items.length);
      return {
        items,
        hasMore: page * limit < total,
        limit,
        offset,
      };
    },

    async getEpisode(episodeId) {
      const json = (await getJson(
        `/api/episodes/${encodeURIComponent(episodeId)}`,
      )) as EpisodeDetailResponseShape;
      return episodeSummarySchema.parse(json?.data?.episode);
    },

    episodeImageUrl(source, size) {
      if (size && source.imageSizes) {
        const resolved = resolveImageRef(source.imageSizes[size]?.url);
        if (resolved) {
          return resolved;
        }
      }

      const fromImage = resolveImageRef(source.image);
      if (fromImage) {
        return fromImage;
      }

      if (source.imageSizes) {
        for (const key of ARTWORK_FALLBACK_ORDER) {
          const resolved = resolveImageRef(source.imageSizes[key]?.url);
          if (resolved) {
            return resolved;
          }
        }
      }

      return resolveImageRef(source.imageSourceUrl);
    },
  };
}
