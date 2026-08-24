import {
  trackSummarySchema,
  podcastSummarySchema,
  episodeSummarySchema,
  episodeDraftSchema,
  episodeStreamSchema,
  uploadedImageSchema,
  type TrackSummary,
  type PodcastSummary,
  type EpisodeSummary,
  type EpisodeDraft,
  type EpisodeStream,
  type UploadedImage,
  type PodcastVisibility,
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
   */
  fetch?: typeof fetch;
  /**
   * Supplies the caller's Oxy access token. Called BEFORE EVERY REQUEST, never
   * cached here, because an access token is short-lived and the host
   * application is the only thing that knows when it was refreshed — an SDK
   * holding its own copy is an SDK that starts sending an expired one.
   *
   * Returning `null`/`undefined` means "no session right now", which is a normal
   * state and not an error: every PUBLIC read below still works without a token,
   * exactly as it did before this existed. Only the authenticated methods refuse,
   * and they say so by name.
   *
   * The token IS sent on public reads when it is available, which is
   * deliberate — it is what lets an owner see their own private show and their
   * own unpublished episodes through the same methods everyone else uses.
   */
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
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

/** The fields `createPodcast` accepts. Mirrors `POST /api/podcasts`. */
export interface CreatePodcastInput {
  title: string;
  description?: string;
  author?: string;
  /** An image id from {@link SyraClient.uploadPodcastImage}, not a URL. */
  image?: string;
  language?: string;
  categories?: string[];
  explicit?: boolean;
  link?: string;
  type?: 'episodic' | 'serial';
  visibility?: PodcastVisibility;
  /** The Alia series this show was generated from; records `provider: 'alia'` provenance. */
  aliaSeriesId?: string;
  /** Disclosure. Independent of {@link CreatePodcastInput.aliaSeriesId} — neither implies the other. */
  aiGenerated?: boolean;
  /** Hosts & Guests as Oxy user ids. Validated server-side; free text is refused. */
  hosts?: string[];
  guests?: string[];
}

/** The fields `updatePodcast` accepts. Every one is optional; omitted means unchanged. */
export interface UpdatePodcastInput {
  title?: string;
  description?: string;
  author?: string;
  image?: string;
  language?: string;
  categories?: string[];
  explicit?: boolean;
  link?: string;
  type?: 'episodic' | 'serial';
  visibility?: PodcastVisibility;
  aiGenerated?: boolean;
}

/** The metadata `createEpisodeDraft` accepts — everything except the audio. */
export interface CreateEpisodeDraftInput {
  title: string;
  description?: string;
  summary?: string;
  season?: number;
  episodeNumber?: number;
  episodeType?: 'full' | 'trailer' | 'bonus';
  explicit?: boolean;
  aiGenerated?: boolean;
  hosts?: string[];
  guests?: string[];
}

/**
 * The metadata the ingest step may set.
 *
 * Deliberately SMALLER than {@link CreateEpisodeDraftInput}, and it is not an
 * oversight: the ticket is redeemed by a process with no user session, so the
 * server accepts only what such a process can know by having produced the audio.
 * Title, artwork, `explicit`, `episodeType`, credits and the AI disclosure were
 * fixed at draft time by the authenticated user and are refused here.
 */
export interface IngestEpisodeInput {
  duration?: number;
  season?: number;
  episodeNumber?: number;
  description?: string;
  summary?: string;
}

/**
 * An audio or image payload, in the shapes the three supported runtimes give you.
 *
 * `Blob`/`File` covers browsers and Node 18+. React Native's `FormData` accepts
 * a `{ uri, name, type }` descriptor instead, which is not a `Blob` at all — it
 * is named here so an RN caller does not have to cast, and so this SDK never has
 * to import anything from React Native to support it.
 */
export type UploadPayload =
  | Blob
  | { uri: string; name?: string; type?: string };

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
  /**
   * Resolve an episode's PLAYABLE audio URL, whichever kind of episode it is.
   *
   * An RSS-mirrored episode carries an absolute `enclosureUrl`; a Syra-hosted one
   * carries `audioSource.url`, a path on the API. This is the one place that
   * knows the difference, so no consumer has to.
   *
   * `undefined` when the episode has no audio yet — a drafted episode awaiting
   * ingest is a real, listable episode with nothing to play, and answering with
   * a broken URL would be worse than answering with nothing.
   */
  episodeAudioUrl(episode: {
    enclosureUrl?: string | null;
    audioSource?: { url?: string | null } | null;
  }): string | undefined;

  // ── Authenticated ──────────────────────────────────────────────────────────
  //
  // Every method below needs `getAccessToken` to return a token; without one they
  // throw `SyraApiError(401)` from the CLIENT rather than making a request that
  // was never going to be accepted.

  /** `GET /api/podcasts/mine` — every show the caller owns, in every state. */
  listMyPodcasts(): Promise<PodcastSummary[]>;
  /** `POST /api/podcasts` — create a Syra-hosted show. */
  createPodcast(input: CreatePodcastInput): Promise<PodcastSummary>;
  /** `PATCH /api/podcasts/:id` — edit a Syra-hosted show you own. */
  updatePodcast(podcastId: string, input: UpdatePodcastInput): Promise<PodcastSummary>;
  /**
   * Change who may see a show. A named affordance over
   * {@link SyraClient.updatePodcast}, because it is the one field with
   * consequences a caller should not discover by reading a diff: making a show
   * `private` withdraws it from every listing AND stops its episodes being
   * transcoded, and publishing it again enqueues the transcodes that were
   * deferred.
   */
  setPodcastVisibility(podcastId: string, visibility: PodcastVisibility): Promise<PodcastSummary>;
  /**
   * `POST /api/images/upload` — store cover art and get the image id back.
   *
   * The id is what {@link CreatePodcastInput.image} wants; a URL is not accepted
   * there, because the API re-hosts artwork rather than hotlinking it.
   */
  uploadPodcastImage(image: UploadPayload, filename?: string): Promise<UploadedImage>;
  /**
   * `POST /api/podcasts/:id/episodes/draft` — reserve an episode now and get a
   * single-use ticket to attach its audio later, from a process with no session.
   *
   * The returned ticket is a bearer capability with a deadline: it is good for
   * ONE redemption against THIS episode, and it stops working if the show
   * changes hands. Treat it as a secret.
   */
  createEpisodeDraft(podcastId: string, input: CreateEpisodeDraftInput): Promise<EpisodeDraft>;
  /**
   * `POST /api/podcasts/episodes/:id/ingest` — redeem a draft's ticket by
   * attaching the audio.
   *
   * Takes the whole {@link EpisodeDraft} rather than a loose id and token, so the
   * two cannot be paired up wrongly by a caller holding several drafts.
   *
   * Authenticated by the TICKET, not by the session — this is the one method here
   * that works with no `getAccessToken` at all, which is the entire point of it.
   */
  ingestEpisode(
    draft: Pick<EpisodeDraft, 'episodeId' | 'ingestTicket'>,
    audio: UploadPayload,
    input?: IngestEpisodeInput,
    filename?: string,
  ): Promise<EpisodeSummary>;
  /**
   * `GET /api/podcasts/episodes/:id/stream` — a tokenized HLS URL for a
   * Syra-hosted episode. Requires a session: the URL it returns embeds a stream
   * token minted for the caller.
   */
  getEpisodeStream(episodeId: string): Promise<EpisodeStream>;
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

  /**
   * The caller's token for THIS request, or `undefined`.
   *
   * Asked every time rather than once at construction: an access token is
   * short-lived, and the host application is the only thing that knows when it
   * was refreshed.
   */
  async function currentToken(): Promise<string | undefined> {
    if (!options.getAccessToken) return undefined;
    const token = await options.getAccessToken();
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  }

  /**
   * The token, or a refusal — for the methods that cannot work without one.
   *
   * Thrown from the CLIENT rather than sent and rejected, so a consumer with no
   * session gets a message naming the method instead of a bare 401 from a
   * request that was never going to be accepted.
   */
  async function requireToken(method: string): Promise<string> {
    const token = await currentToken();
    if (!token) {
      throw new SyraApiError(
        401,
        `@syra.fm/sdk: ${method}() needs a signed-in caller. Pass \`getAccessToken\` to ` +
          'createSyraClient, and make sure it returns a token for the current session.',
      );
    }
    return token;
  }

  /** Raise the API's own error, preferring the message it sent over the status text. */
  async function raiseFor(response: Response, path: string): Promise<never> {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
        detail = `${response.status} ${body.error}`;
      }
    } catch {
      // A non-JSON error body is not itself an error worth reporting; the status
      // is what the caller acts on.
    }
    throw new SyraApiError(response.status, `Syra API request failed: ${detail} (${path})`);
  }

  interface RequestInit_ {
    method?: string;
    body?: BodyInit;
    /** Extra headers. `Authorization` is added here, never by a caller. */
    headers?: Record<string, string>;
    /** Refuse before sending when there is no session. The value is the method name. */
    requires?: string;
    /**
     * Never attach the session token, even when one is available.
     *
     * For a request that carries its OWN credential — the ingest ticket. Sending
     * both would leave the server's answer ambiguous about which one authorized
     * the write, and would mean a worker that happens to hold a user token
     * behaves differently from one that does not. Exactly one credential per
     * request.
     */
    anonymous?: boolean;
  }

  async function request(path: string, init: RequestInit_ = {}): Promise<unknown> {
    const doFetch = resolveFetch();
    const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };

    if (init.requires) {
      headers.Authorization = `Bearer ${await requireToken(init.requires)}`;
    } else if (!init.anonymous) {
      // Sent when available even on public reads — it is what lets an owner see
      // their own private show through the same method everyone else calls.
      const token = await currentToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const response = await doFetch(`${baseURL}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (!response.ok) return raiseFor(response, path);
    return response.json();
  }

  async function getJson(path: string): Promise<unknown> {
    return request(path);
  }

  async function postJson(path: string, body: unknown, requires: string): Promise<unknown> {
    return request(path, {
      method: 'POST',
      requires,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * Append an upload to a `FormData`, in whichever shape the runtime gave us.
   *
   * The RN `{ uri, name, type }` descriptor is not a `Blob` and the DOM
   * `FormData.append` signature does not admit it, so it goes through one cast
   * confined to this function — rather than every call site, or a `declare
   * module` shim that would shadow the real DOM types in every consumer.
   */
  function appendUpload(form: FormData, field: string, payload: UploadPayload, filename?: string): void {
    if (typeof Blob !== 'undefined' && payload instanceof Blob) {
      form.append(field, payload, filename);
      return;
    }
    const descriptor = payload as { uri: string; name?: string; type?: string };
    const name = filename ?? descriptor.name ?? field;
    form.append(field, descriptor as unknown as Blob, name);
  }

  /** Drop `undefined` fields so a partial input never sends `"key": null`. */
  function defined(input: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
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
        /**
         * A single malformed episode row must not fail the whole listing — but
         * "has no enclosure" is no longer malformed. It used to be, and that is
         * what made every SYRA-HOSTED episode disappear from this method: their
         * audio is `audioSource.url`, not an enclosure. The schema now validates
         * IDENTITY and leaves playability to `episodeAudioUrl`, which is also
         * the only honest answer for a drafted episode whose audio has not
         * arrived yet.
         */
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

    episodeAudioUrl(episode) {
      // An RSS mirror's enclosure is already absolute and points at somebody
      // else's host, so it is returned untouched.
      if (episode.enclosureUrl && /^https?:\/\//i.test(episode.enclosureUrl)) {
        return episode.enclosureUrl;
      }
      const sourceUrl = episode.audioSource?.url;
      if (sourceUrl) {
        return /^https?:\/\//i.test(sourceUrl) ? sourceUrl : `${baseURL}${sourceUrl}`;
      }
      // A relative enclosure is unusual but representable; resolve it the same way.
      if (episode.enclosureUrl) return `${baseURL}${episode.enclosureUrl}`;
      return undefined;
    },

    async listMyPodcasts() {
      const json = (await request('/api/podcasts/mine', {
        requires: 'listMyPodcasts',
      })) as PodcastSearchResponseShape;
      const rows = Array.isArray(json?.data) ? json.data : [];

      const items: PodcastSummary[] = [];
      for (const raw of rows) {
        const parsed = podcastSummarySchema.safeParse(raw);
        if (parsed.success) items.push(parsed.data);
      }
      return items;
    },

    async createPodcast(input) {
      const json = (await postJson(
        '/api/podcasts',
        defined({ ...input }),
        'createPodcast',
      )) as { data?: unknown };
      return podcastSummarySchema.parse(json?.data);
    },

    async updatePodcast(podcastId, input) {
      const json = (await request(`/api/podcasts/${encodeURIComponent(podcastId)}`, {
        method: 'PATCH',
        requires: 'updatePodcast',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(defined({ ...input })),
      })) as { data?: unknown };
      return podcastSummarySchema.parse(json?.data);
    },

    async setPodcastVisibility(podcastId, visibility) {
      return this.updatePodcast(podcastId, { visibility });
    },

    async uploadPodcastImage(image, filename) {
      const form = new FormData();
      // `image` is the field name `POST /api/images/upload` reads.
      appendUpload(form, 'image', image, filename);

      // No `Content-Type`: the runtime sets it, INCLUDING the multipart boundary,
      // which cannot be written by hand. Setting it here produces a body the
      // server cannot parse.
      const json = (await request('/api/images/upload', {
        method: 'POST',
        requires: 'uploadPodcastImage',
        body: form,
      })) as unknown;
      return uploadedImageSchema.parse(json);
    },

    async createEpisodeDraft(podcastId, input) {
      const json = (await postJson(
        `/api/podcasts/${encodeURIComponent(podcastId)}/episodes/draft`,
        defined({ ...input }),
        'createEpisodeDraft',
      )) as { data?: unknown };
      return episodeDraftSchema.parse(json?.data);
    },

    async ingestEpisode(draft, audio, input = {}, filename) {
      const form = new FormData();
      // `audioFile` is the field name the ingest endpoint reads.
      appendUpload(form, 'audioFile', audio, filename ?? 'episode.mp3');
      for (const [key, value] of Object.entries(defined({ ...input }))) {
        form.append(key, String(value));
      }

      /**
       * `anonymous`, and it is load-bearing rather than tidy: this request is
       * authenticated by the TICKET alone, which is the whole reason the
       * draft/ingest pair exists. Without it a worker that HAPPENS to hold a user
       * token would send both credentials — behaving differently from one that
       * does not, and leaving the server's answer ambiguous about which
       * authorized the write. Caught by a test, not by review.
       */
      const json = (await request(
        `/api/podcasts/episodes/${encodeURIComponent(draft.episodeId)}/ingest`,
        {
          method: 'POST',
          anonymous: true,
          headers: { 'X-Ingest-Ticket': draft.ingestTicket },
          body: form,
        },
      )) as { data?: unknown };
      return episodeSummarySchema.parse(json?.data);
    },

    async getEpisodeStream(episodeId) {
      const json = await request(
        `/api/podcasts/episodes/${encodeURIComponent(episodeId)}/stream`,
        { requires: 'getEpisodeStream' },
      );
      return episodeStreamSchema.parse(json);
    },
  };
}
