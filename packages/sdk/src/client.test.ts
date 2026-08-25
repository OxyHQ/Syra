import { describe, it, expect } from 'bun:test';
import {
  createSyraClient,
  SyraApiError,
  DEFAULT_SYRA_BASE_URL,
  DEFAULT_SYRA_WEB_BASE_URL,
} from './index';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTrack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '507f1f77bcf86cd799439011',
    title: 'Test Track',
    artistId: 'artist-1',
    artistName: 'Test Artist',
    duration: 180,
    isExplicit: false,
    isAvailable: true,
    source: 'upload',
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    previewAvailable: true,
    ...overrides,
  };
}

function makePodcast(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '507f1f77bcf86cd799439021',
    title: 'Test Show',
    author: 'Test Publisher',
    description: 'A show about testing.',
    image: '507f1f77bcf86cd799439022',
    explicit: false,
    type: 'episodic',
    source: 'rss',
    refreshIntervalMin: 60,
    episodeCount: 12,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEpisode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '507f1f77bcf86cd799439031',
    podcastId: '507f1f77bcf86cd799439021',
    podcastTitle: 'Test Show',
    title: 'Test Episode',
    description: 'An episode about testing.',
    guid: 'guid-1',
    enclosureUrl: 'https://api.fastcast.ai/audio/guid-1.mp3',
    enclosureType: 'audio/mpeg',
    enclosureLength: 12_345_678,
    duration: 1800,
    pubDate: '2026-01-01T00:00:00.000Z',
    episodeType: 'full',
    image: '507f1f77bcf86cd799439032',
    imageSourceUrl: 'https://cdn.example.com/episode.jpg',
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A Syra-HOSTED episode: no enclosure at all, audio at a path on the API.
 *
 * This is what everything created through the Syra API looks like — the creator
 * upload path, and every episode Alia drafts and ingests. It is the shape the
 * SDK used to drop on the floor.
 */
function makeSyraEpisode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const episode = makeEpisode({
    id: '507f1f77bcf86cd799439041',
    audioSource: { url: '/api/podcasts/episodes/507f1f77bcf86cd799439041/audio', format: 'mp3' },
    ...overrides,
  });
  // Deleted rather than set to `undefined`, so the fixture is byte-for-byte what
  // the API sends: the serializer OMITS the key for a Syra-hosted episode.
  delete episode.enclosureUrl;
  delete episode.enclosureType;
  delete episode.enclosureLength;
  return episode;
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(
  handler: (url: string) => { status?: number; body: unknown },
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    // Headers are recorded lower-cased: a test asserting on `Authorization`
    // must not pass or fail on the casing a transport happened to use.
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url, method: init?.method ?? 'GET', headers, body: init?.body });
    const { status = 200, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** The JSON a recorded call sent, parsed. */
function sentJson(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.body)) as Record<string, unknown>;
}

// ── searchTracks ──────────────────────────────────────────────────────────────

describe('createSyraClient.searchTracks', () => {
  it('calls /api/search with category=tracks and the limit, returns a page of preview-available tracks', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        results: {
          tracks: [
            makeTrack({ id: '507f1f77bcf86cd799439011', previewAvailable: true }),
            makeTrack({ id: '507f1f77bcf86cd799439012', previewAvailable: false }),
          ],
        },
        hasMore: false,
        limit: 10,
        offset: 0,
      },
    }));

    const client = createSyraClient({ baseURL: 'https://api.example.test', fetch });
    const page = await client.searchTracks('hello', { limit: 10 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe('507f1f77bcf86cd799439011');
    expect(page.hasMore).toBe(false);
    expect(page.limit).toBe(10);
    expect(page.offset).toBe(0);

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/search');
    expect(url.searchParams.get('q')).toBe('hello');
    expect(url.searchParams.get('category')).toBe('tracks');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.has('offset')).toBe(false);
  });

  it('sends the offset param and reports hasMore/offset/limit from the backend', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        results: { tracks: [makeTrack()] },
        hasMore: true,
        limit: 20,
        offset: 40,
      },
    }));

    const client = createSyraClient({ baseURL: 'https://api.example.test', fetch });
    const page = await client.searchTracks('hello', { limit: 20, offset: 40 });

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.limit).toBe(20);
    expect(page.offset).toBe(40);

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('offset')).toBe('40');
    expect(url.searchParams.get('limit')).toBe('20');
  });

  it('reports backend hasMore even when client-side preview filtering empties the page', async () => {
    const { fetch } = fakeFetch(() => ({
      body: {
        results: {
          tracks: [
            makeTrack({ previewAvailable: false }),
            makeTrack({ previewAvailable: false }),
          ],
        },
        hasMore: true,
        limit: 2,
        offset: 0,
      },
    }));

    const client = createSyraClient({ fetch });
    const page = await client.searchTracks('x', { limit: 2 });

    // All rows were filtered out, but the page is NOT the last one.
    expect(page.items).toHaveLength(0);
    expect(page.hasMore).toBe(true);
  });

  it('drops malformed rows without throwing', async () => {
    const { fetch } = fakeFetch(() => ({
      body: {
        results: {
          tracks: [
            { id: 'broken' }, // missing required fields → safeParse fails
            makeTrack({ previewAvailable: true }),
          ],
        },
      },
    }));

    const client = createSyraClient({ fetch });
    const page = await client.searchTracks('x');
    expect(page.items).toHaveLength(1);
  });

  it('returns an empty page with hasMore=false when results.tracks is absent', async () => {
    const { fetch } = fakeFetch(() => ({ body: {} }));
    const client = createSyraClient({ fetch });
    const page = await client.searchTracks('x');
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.offset).toBe(0);
  });
});

// ── getTrack ──────────────────────────────────────────────────────────────────

describe('createSyraClient.getTrack', () => {
  it('fetches /api/tracks/:id and validates the response', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: makeTrack() }));
    const client = createSyraClient({ baseURL: 'https://api.example.test', fetch });

    const track = await client.getTrack('507f1f77bcf86cd799439011');
    expect(track.title).toBe('Test Track');
    expect(calls[0].url).toBe('https://api.example.test/api/tracks/507f1f77bcf86cd799439011');
  });

  it('throws SyraApiError on a non-2xx response', async () => {
    const { fetch } = fakeFetch(() => ({ status: 404, body: { error: 'not found' } }));
    const client = createSyraClient({ fetch });

    await expect(client.getTrack('507f1f77bcf86cd799439011')).rejects.toBeInstanceOf(SyraApiError);
  });

  it('throws when the response fails schema validation', async () => {
    const { fetch } = fakeFetch(() => ({ body: { id: 'x' } }));
    const client = createSyraClient({ fetch });
    await expect(client.getTrack('x')).rejects.toThrow();
  });
});

// ── previewUrl ────────────────────────────────────────────────────────────────

describe('createSyraClient.previewUrl', () => {
  it('builds the preview URL with a default start of 0', () => {
    const client = createSyraClient({ baseURL: 'https://api.example.test' });
    expect(client.previewUrl('abc')).toBe('https://api.example.test/api/preview/abc.mp3?start=0');
  });

  it('uses the provided start offset and clamps to an integer >= 0', () => {
    const client = createSyraClient({ baseURL: 'https://api.example.test' });
    expect(client.previewUrl('abc', 42.9)).toBe('https://api.example.test/api/preview/abc.mp3?start=42');
    expect(client.previewUrl('abc', -5)).toBe('https://api.example.test/api/preview/abc.mp3?start=0');
  });

  it('defaults to the production base URL', () => {
    const client = createSyraClient();
    expect(client.previewUrl('abc')).toBe(`${DEFAULT_SYRA_BASE_URL}/api/preview/abc.mp3?start=0`);
  });
});

// ── artworkUrl ────────────────────────────────────────────────────────────────

describe('createSyraClient.artworkUrl', () => {
  const client = createSyraClient({ baseURL: 'https://api.example.test' });

  it('resolves a bare ObjectId string to an absolute images URL', () => {
    expect(client.artworkUrl('507f1f77bcf86cd799439011')).toBe(
      'https://api.example.test/api/images/507f1f77bcf86cd799439011',
    );
  });

  it('prefixes a relative /api/images path', () => {
    expect(client.artworkUrl('/api/images/507f1f77bcf86cd799439011')).toBe(
      'https://api.example.test/api/images/507f1f77bcf86cd799439011',
    );
  });

  it('passes through an absolute http(s) URL', () => {
    expect(client.artworkUrl('https://cdn.example.com/x.jpg')).toBe('https://cdn.example.com/x.jpg');
  });

  it('prefers a named size from coverArtSizes', () => {
    const url = client.artworkUrl(
      {
        coverArt: '/api/images/507f1f77bcf86cd799439011',
        coverArtSizes: {
          large: {
            id: '507f1f77bcf86cd799439012',
            url: '/api/images/507f1f77bcf86cd799439012',
            width: 600,
            height: 600,
          },
        },
      },
      'large',
    );
    expect(url).toBe('https://api.example.test/api/images/507f1f77bcf86cd799439012');
  });

  it('falls back to coverArt when the requested size is missing', () => {
    const url = client.artworkUrl(
      { coverArt: '/api/images/507f1f77bcf86cd799439011', coverArtSizes: {} },
      'large',
    );
    expect(url).toBe('https://api.example.test/api/images/507f1f77bcf86cd799439011');
  });

  it('returns undefined when nothing resolvable is present', () => {
    expect(client.artworkUrl({})).toBeUndefined();
    expect(client.artworkUrl('not-an-id')).toBeUndefined();
  });
});

// ── searchPodcasts ──────────────────────────────────────────────────────────────

describe('createSyraClient.searchPodcasts', () => {
  it('calls /api/podcasts/search with q and limit, returns a page of parsed shows', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        data: [
          makePodcast({ id: '507f1f77bcf86cd799439021' }),
          makePodcast({ id: '507f1f77bcf86cd799439023', title: 'Second Show' }),
        ],
        hasMore: false,
        limit: 5,
        offset: 0,
      },
    }));

    const client = createSyraClient({ baseURL: 'https://api.example.test', fetch });
    const page = await client.searchPodcasts('news', { limit: 5 });

    expect(page.items).toHaveLength(2);
    expect(page.items[0].id).toBe('507f1f77bcf86cd799439021');
    expect(page.items[0].author).toBe('Test Publisher');
    expect(page.hasMore).toBe(false);
    expect(page.limit).toBe(5);
    expect(page.offset).toBe(0);

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/podcasts/search');
    expect(url.searchParams.get('q')).toBe('news');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.has('offset')).toBe(false);
  });

  it('sends the offset param and reports hasMore/offset from the backend', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { data: [makePodcast()], hasMore: true, limit: 10, offset: 20 },
    }));

    const client = createSyraClient({ baseURL: 'https://api.example.test', fetch });
    const page = await client.searchPodcasts('news', { limit: 10, offset: 20 });

    expect(page.hasMore).toBe(true);
    expect(page.limit).toBe(10);
    expect(page.offset).toBe(20);

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('offset')).toBe('20');
  });

  it('omits the limit and offset params when not provided', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { data: [makePodcast()] } }));
    const client = createSyraClient({ fetch });
    await client.searchPodcasts('news');
    const url = new URL(calls[0].url);
    expect(url.searchParams.has('limit')).toBe(false);
    expect(url.searchParams.has('offset')).toBe(false);
  });

  it('drops malformed rows without throwing', async () => {
    const { fetch } = fakeFetch(() => ({
      body: { data: [{ id: 'broken' }, makePodcast()] },
    }));
    const client = createSyraClient({ fetch });
    const page = await client.searchPodcasts('x');
    expect(page.items).toHaveLength(1);
  });

  it('returns an empty page with hasMore=false when data is absent', async () => {
    const { fetch } = fakeFetch(() => ({ body: {} }));
    const client = createSyraClient({ fetch });
    const page = await client.searchPodcasts('x');
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.offset).toBe(0);
  });
});

// ── getPodcast ──────────────────────────────────────────────────────────────────

describe('createSyraClient.getPodcast', () => {
  it('fetches /api/podcasts/:id and validates data.podcast', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { data: { podcast: makePodcast(), episodes: [], persons: [] } },
    }));
    const client = createSyraClient({ baseURL: 'https://api.example.test', fetch });

    const podcast = await client.getPodcast('507f1f77bcf86cd799439021');
    expect(podcast.title).toBe('Test Show');
    expect(calls[0].url).toBe('https://api.example.test/api/podcasts/507f1f77bcf86cd799439021');
  });

  it('throws SyraApiError on a non-2xx response', async () => {
    const { fetch } = fakeFetch(() => ({ status: 404, body: { error: 'not found' } }));
    const client = createSyraClient({ fetch });
    await expect(client.getPodcast('507f1f77bcf86cd799439021')).rejects.toBeInstanceOf(SyraApiError);
  });

  it('throws when data.podcast fails schema validation', async () => {
    const { fetch } = fakeFetch(() => ({ body: { data: { podcast: { id: 'x' } } } }));
    const client = createSyraClient({ fetch });
    await expect(client.getPodcast('x')).rejects.toThrow();
  });
});

// ── podcastUrl ────────────────────────────────────────────────────────────────

describe('createSyraClient.podcastUrl', () => {
  it('builds the web deep link from the web base URL, not the API host', () => {
    const client = createSyraClient({
      baseURL: 'https://api.example.test',
      webBaseURL: 'https://web.example.test',
    });
    expect(client.podcastUrl('507f1f77bcf86cd799439021')).toBe(
      'https://web.example.test/podcasts/507f1f77bcf86cd799439021',
    );
  });

  it('defaults to the production web base URL', () => {
    const client = createSyraClient();
    expect(client.podcastUrl('abc')).toBe(`${DEFAULT_SYRA_WEB_BASE_URL}/podcasts/abc`);
  });

  it('does not use the API base URL for the deep link', () => {
    const client = createSyraClient({ baseURL: 'https://api.example.test' });
    expect(client.podcastUrl('abc')).toBe(`${DEFAULT_SYRA_WEB_BASE_URL}/podcasts/abc`);
    expect(DEFAULT_SYRA_WEB_BASE_URL).not.toBe(DEFAULT_SYRA_BASE_URL);
  });
});

// ── podcastArtworkUrl ────────────────────────────────────────────────────────────

describe('createSyraClient.podcastArtworkUrl', () => {
  const client = createSyraClient({ baseURL: 'https://api.example.test' });

  it('resolves the re-hosted image id to an absolute images URL', () => {
    expect(client.podcastArtworkUrl({ image: '507f1f77bcf86cd799439022' })).toBe(
      'https://api.example.test/api/images/507f1f77bcf86cd799439022',
    );
  });

  it('prefers a named size from imageSizes', () => {
    const url = client.podcastArtworkUrl(
      {
        image: '507f1f77bcf86cd799439022',
        imageSizes: {
          large: {
            id: '507f1f77bcf86cd799439023',
            url: '/api/images/507f1f77bcf86cd799439023',
            width: 640,
            height: 640,
          },
        },
      },
      'large',
    );
    expect(url).toBe('https://api.example.test/api/images/507f1f77bcf86cd799439023');
  });

  it('falls back to imageSourceUrl when no Syra image is present', () => {
    expect(
      client.podcastArtworkUrl({ imageSourceUrl: 'https://cdn.example.com/cover.jpg' }),
    ).toBe('https://cdn.example.com/cover.jpg');
  });

  it('returns undefined when nothing resolvable is present', () => {
    expect(client.podcastArtworkUrl({})).toBeUndefined();
    expect(client.podcastArtworkUrl({ image: 'not-an-id' })).toBeUndefined();
  });
});

// ── getPodcastEpisodes ──────────────────────────────────────────────────────────

describe('createSyraClient.getPodcastEpisodes', () => {
  it('calls /api/podcasts/:id/episodes with page and limit and returns parsed episodes', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        data: [
          makeEpisode({ id: '507f1f77bcf86cd799439031' }),
          makeEpisode({ id: '507f1f77bcf86cd799439033', title: 'Second Episode' }),
        ],
        total: 2,
        page: 1,
        limit: 20,
      },
    }));

    const client = createSyraClient({ baseURL: 'https://api.example.test', fetch });
    const page = await client.getPodcastEpisodes('507f1f77bcf86cd799439021', { limit: 20 });

    expect(page.items).toHaveLength(2);
    expect(page.items[0].id).toBe('507f1f77bcf86cd799439031');
    expect(page.items[0].enclosureUrl).toBe('https://api.fastcast.ai/audio/guid-1.mp3');
    expect(page.hasMore).toBe(false);
    expect(page.limit).toBe(20);
    expect(page.offset).toBe(0);

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/podcasts/507f1f77bcf86cd799439021/episodes');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('20');
  });

  it('translates a zero-based offset into a 1-based page and derives hasMore from total', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { data: [makeEpisode()], total: 45, page: 3, limit: 10 },
    }));

    const client = createSyraClient({ baseURL: 'https://api.example.test', fetch });
    const page = await client.getPodcastEpisodes('507f1f77bcf86cd799439021', {
      limit: 10,
      offset: 20,
    });

    // offset 20 / limit 10 → page 3; 3 * 10 = 30 < 45 → more remain.
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(page.offset).toBe(20);
    expect(page.limit).toBe(10);
    expect(page.hasMore).toBe(true);
  });

  it('reports hasMore=false when the page reaches the end of the total', async () => {
    const { fetch } = fakeFetch(() => ({
      body: { data: [makeEpisode()], total: 20, page: 2, limit: 10 },
    }));
    const client = createSyraClient({ fetch });
    const page = await client.getPodcastEpisodes('507f1f77bcf86cd799439021', {
      limit: 10,
      offset: 10,
    });
    // page 2 * limit 10 = 20, not < total 20 → this is the last page.
    expect(page.hasMore).toBe(false);
  });

  it('KEEPS a Syra-hosted episode, which it used to drop', async () => {
    /**
     * The bug this change exists for, as a test.
     *
     * `enclosureUrl` was REQUIRED, and a Syra-hosted episode has none — its audio
     * is `audioSource.url`. So every episode created through the Syra API failed
     * the schema and was silently dropped from this listing: the entire
     * first-party catalogue, invisible, with no error to notice. Against the
     * previous schema this case returns ONE item; it must return two.
     *
     * The RSS episode beside it is the positive control — without it, "two items"
     * could be satisfied by a schema that had stopped validating anything.
     */
    const { fetch } = fakeFetch(() => ({
      body: { data: [makeSyraEpisode(), makeEpisode()], total: 2 },
    }));
    const client = createSyraClient({ fetch });
    const page = await client.getPodcastEpisodes('507f1f77bcf86cd799439021', { limit: 10 });

    expect(page.items).toHaveLength(2);
    expect(page.items[0].id).toBe('507f1f77bcf86cd799439041');
    expect(page.items[0].enclosureUrl).toBeUndefined();
    expect(page.items[0].audioSource?.url).toBe(
      '/api/podcasts/episodes/507f1f77bcf86cd799439041/audio',
    );
    expect(page.items[1].enclosureUrl).toBe('https://api.fastcast.ai/audio/guid-1.mp3');
  });

  it('keeps a DRAFTED episode that has no audio at all', async () => {
    /**
     * The other end of the same rule. An episode drafted for asynchronous ingest
     * exists, is listable by its owner, and has neither an enclosure nor an
     * audioSource until the worker redeems its ticket. Dropping it would hide a
     * creator's own in-progress episode from them.
     */
    const drafted = makeSyraEpisode({ id: '507f1f77bcf86cd799439042', status: 'processing' });
    delete drafted.audioSource;

    const { fetch } = fakeFetch(() => ({ body: { data: [drafted], total: 1 } }));
    const client = createSyraClient({ fetch });
    const page = await client.getPodcastEpisodes('507f1f77bcf86cd799439021', { limit: 10 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].status).toBe('processing');
  });

  it('still drops a row that is genuinely malformed', async () => {
    // The counterpart that keeps the two changes apart: relaxing `enclosureUrl`
    // must not turn the schema into a pass-through. A row with no `id` is still
    // malformed and still goes.
    const broken = makeSyraEpisode();
    delete broken.id;

    const { fetch } = fakeFetch(() => ({ body: { data: [broken, makeSyraEpisode()], total: 2 } }));
    const client = createSyraClient({ fetch });
    const page = await client.getPodcastEpisodes('507f1f77bcf86cd799439021', { limit: 10 });

    expect(page.items).toHaveLength(1);
  });

  it('defaults the limit and returns an empty page when data is absent', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    const client = createSyraClient({ fetch });
    const page = await client.getPodcastEpisodes('507f1f77bcf86cd799439021');
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(20);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('20');
  });
});

// ── getEpisode ──────────────────────────────────────────────────────────────────

describe('createSyraClient.getEpisode', () => {
  it('fetches /api/episodes/:id and validates data.episode', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { data: { episode: makeEpisode(), persons: [] } },
    }));
    const client = createSyraClient({ baseURL: 'https://api.example.test', fetch });

    const episode = await client.getEpisode('507f1f77bcf86cd799439031');
    expect(episode.title).toBe('Test Episode');
    expect(episode.enclosureUrl).toBe('https://api.fastcast.ai/audio/guid-1.mp3');
    expect(calls[0].url).toBe('https://api.example.test/api/episodes/507f1f77bcf86cd799439031');
  });

  it('throws SyraApiError on a non-2xx response', async () => {
    const { fetch } = fakeFetch(() => ({ status: 404, body: { error: 'not found' } }));
    const client = createSyraClient({ fetch });
    await expect(client.getEpisode('507f1f77bcf86cd799439031')).rejects.toBeInstanceOf(SyraApiError);
  });

  it('throws when data.episode fails schema validation', async () => {
    const { fetch } = fakeFetch(() => ({ body: { data: { episode: { id: 'x' } } } }));
    const client = createSyraClient({ fetch });
    await expect(client.getEpisode('x')).rejects.toThrow();
  });
});

// ── episodeImageUrl ──────────────────────────────────────────────────────────────

describe('createSyraClient.episodeImageUrl', () => {
  const client = createSyraClient({ baseURL: 'https://api.example.test' });

  it('resolves the re-hosted image id to an absolute images URL', () => {
    expect(client.episodeImageUrl({ image: '507f1f77bcf86cd799439032' })).toBe(
      'https://api.example.test/api/images/507f1f77bcf86cd799439032',
    );
  });

  it('prefers a named size from imageSizes', () => {
    const url = client.episodeImageUrl(
      {
        image: '507f1f77bcf86cd799439032',
        imageSizes: {
          large: {
            id: '507f1f77bcf86cd799439033',
            url: '/api/images/507f1f77bcf86cd799439033',
            width: 640,
            height: 640,
          },
        },
      },
      'large',
    );
    expect(url).toBe('https://api.example.test/api/images/507f1f77bcf86cd799439033');
  });

  it('falls back to imageSourceUrl when no Syra image is present', () => {
    expect(client.episodeImageUrl({ imageSourceUrl: 'https://cdn.example.com/episode.jpg' })).toBe(
      'https://cdn.example.com/episode.jpg',
    );
  });

  it('returns undefined when nothing resolvable is present', () => {
    expect(client.episodeImageUrl({})).toBeUndefined();
    expect(client.episodeImageUrl({ image: 'not-an-id' })).toBeUndefined();
  });
});

// ── The Syra-hosted episode, on the by-id path ───────────────────────────────

describe('createSyraClient.getEpisode — Syra-hosted episodes', () => {
  it('returns one instead of THROWING, which is what it used to do', async () => {
    /**
     * `getEpisode` parses with `.parse`, not `.safeParse`, so the required
     * `enclosureUrl` did not drop a Syra-hosted episode here — it threw a
     * ZodError at the caller. Same bug, louder failure mode.
     */
    const { fetch } = fakeFetch(() => ({ body: { data: { episode: makeSyraEpisode() } } }));
    const client = createSyraClient({ fetch });

    const episode = await client.getEpisode('507f1f77bcf86cd799439041');
    expect(episode.id).toBe('507f1f77bcf86cd799439041');
    expect(episode.enclosureUrl).toBeUndefined();
    expect(episode.audioSource?.format).toBe('mp3');
  });
});

// ── episodeAudioUrl ─────────────────────────────────────────────────────────

describe('createSyraClient.episodeAudioUrl', () => {
  const client = createSyraClient({ baseURL: 'https://api.example.test' });

  it('returns an RSS enclosure untouched — it is somebody else’s host', () => {
    expect(client.episodeAudioUrl({ enclosureUrl: 'https://cdn.example.com/a.mp3' })).toBe(
      'https://cdn.example.com/a.mp3',
    );
  });

  it('resolves a Syra-hosted path against the API base URL', () => {
    expect(
      client.episodeAudioUrl({ audioSource: { url: '/api/podcasts/episodes/e1/audio' } }),
    ).toBe('https://api.example.test/api/podcasts/episodes/e1/audio');
  });

  it('answers undefined for a drafted episode with no audio yet', () => {
    // Not a broken URL, and not a throw: a drafted episode is a real episode
    // with nothing to play, and the caller is the one who decides what to show.
    expect(client.episodeAudioUrl({})).toBeUndefined();
    expect(client.episodeAudioUrl({ enclosureUrl: null, audioSource: null })).toBeUndefined();
  });

  it('prefers the enclosure when an episode somehow carries both', () => {
    // A mirrored episode that has also been cached locally. The enclosure is the
    // canonical origin, so it wins; the assertion exists so the precedence is a
    // decision rather than an accident of ordering.
    expect(
      client.episodeAudioUrl({
        enclosureUrl: 'https://cdn.example.com/a.mp3',
        audioSource: { url: '/api/podcasts/episodes/e1/audio' },
      }),
    ).toBe('https://cdn.example.com/a.mp3');
  });
});

// ── The authenticated transport ─────────────────────────────────────────────

describe('createSyraClient — the access token', () => {
  it('sends NO Authorization header when no token provider is configured', async () => {
    // The compatibility guarantee: every public read keeps working exactly as it
    // did before authentication existed.
    const { fetch, calls } = fakeFetch(() => ({ body: { data: { podcast: makePodcast() } } }));
    const client = createSyraClient({ fetch });

    await client.getPodcast('507f1f77bcf86cd799439021');
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it('sends no Authorization header when the provider returns null', async () => {
    // "Signed out" is a normal state, not an error — a public read still works.
    const { fetch, calls } = fakeFetch(() => ({ body: { data: { podcast: makePodcast() } } }));
    const client = createSyraClient({ fetch, getAccessToken: () => null });

    await client.getPodcast('507f1f77bcf86cd799439021');
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it('sends the token on a PUBLIC read when one is available', async () => {
    // Deliberate: it is what lets an owner see their own private show through
    // the same method every other caller uses.
    const { fetch, calls } = fakeFetch(() => ({ body: { data: { podcast: makePodcast() } } }));
    const client = createSyraClient({ fetch, getAccessToken: () => 'tok-123' });

    await client.getPodcast('507f1f77bcf86cd799439021');
    expect(calls[0].headers.authorization).toBe('Bearer tok-123');
  });

  it('asks for the token on EVERY request, never caching it', async () => {
    /**
     * An access token is short-lived and the host application is the only thing
     * that knows when it was refreshed. A client that read the provider once at
     * construction would keep sending the first token until it expired.
     */
    const tokens = ['first', 'second', 'third'];
    let index = 0;
    const { fetch, calls } = fakeFetch(() => ({ body: { data: { podcast: makePodcast() } } }));
    const client = createSyraClient({ fetch, getAccessToken: () => tokens[index++] });

    await client.getPodcast('a');
    await client.getPodcast('b');
    await client.getPodcast('c');

    expect(calls.map((call) => call.headers.authorization)).toEqual([
      'Bearer first',
      'Bearer second',
      'Bearer third',
    ]);
  });

  it('awaits an async token provider', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { data: { podcast: makePodcast() } } }));
    const client = createSyraClient({
      fetch,
      getAccessToken: async () => Promise.resolve('async-tok'),
    });

    await client.getPodcast('507f1f77bcf86cd799439021');
    expect(calls[0].headers.authorization).toBe('Bearer async-tok');
  });
});

describe('the authenticated methods refuse without a session', () => {
  /**
   * Refused by the CLIENT, before any request — so a consumer with no session
   * gets a message naming the method instead of a bare 401 from a request that
   * was never going to be accepted. `calls` being empty is the load-bearing half.
   */
  const cases: [string, (client: ReturnType<typeof createSyraClient>) => Promise<unknown>][] = [
    ['listMyPodcasts', (client) => client.listMyPodcasts()],
    ['createPodcast', (client) => client.createPodcast({ title: 'X' })],
    ['updatePodcast', (client) => client.updatePodcast('p1', { title: 'X' })],
    ['setPodcastVisibility', (client) => client.setPodcastVisibility('p1', 'private')],
    ['createEpisodeDraft', (client) => client.createEpisodeDraft('p1', { title: 'X' })],
    ['getEpisodeStream', (client) => client.getEpisodeStream('e1')],
  ];

  for (const [name, call] of cases) {
    it(`${name} throws 401 and makes NO request`, async () => {
      const { fetch, calls } = fakeFetch(() => ({ body: {} }));
      const client = createSyraClient({ fetch });

      await expect(call(client)).rejects.toBeInstanceOf(SyraApiError);
      expect(`${name} requests: ${calls.length}`).toBe(`${name} requests: 0`);
    });
  }

  it('names the method and the option in the message', async () => {
    const { fetch } = fakeFetch(() => ({ body: {} }));
    const client = createSyraClient({ fetch });

    await expect(client.createPodcast({ title: 'X' })).rejects.toThrow(/createPodcast/);
    await expect(client.createPodcast({ title: 'X' })).rejects.toThrow(/getAccessToken/);
  });

  it('succeeds once a token is available — so the refusals are the session, not the method', async () => {
    // The positive control for all six above.
    const { fetch, calls } = fakeFetch(() => ({ body: { data: [makePodcast()] } }));
    const client = createSyraClient({ fetch, getAccessToken: () => 'tok' });

    const shows = await client.listMyPodcasts();
    expect(shows).toHaveLength(1);
    expect(calls[0].headers.authorization).toBe('Bearer tok');
  });
});

// ── The write methods ───────────────────────────────────────────────────────

describe('createSyraClient write methods', () => {
  function authedClient(handler: (url: string) => { status?: number; body: unknown }) {
    const { fetch, calls } = fakeFetch(handler);
    return { client: createSyraClient({ baseURL: 'https://api.example.test', fetch, getAccessToken: () => 'tok' }), calls };
  }

  it('createPodcast POSTs JSON and returns the parsed show', async () => {
    const { client, calls } = authedClient(() => ({
      body: { data: makePodcast({ visibility: 'private', aiGenerated: true }) },
    }));

    const show = await client.createPodcast({
      title: 'Generated Show',
      visibility: 'private',
      aliaSeriesId: 'alia-42',
      aiGenerated: true,
    });

    expect(calls[0].url).toBe('https://api.example.test/api/podcasts');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(sentJson(calls[0])).toEqual({
      title: 'Generated Show',
      visibility: 'private',
      aliaSeriesId: 'alia-42',
      aiGenerated: true,
    });
    expect(show.visibility).toBe('private');
    expect(show.aiGenerated).toBe(true);
  });

  it('createPodcast omits fields the caller did not set, rather than sending null', async () => {
    // `undefined` in an object literal survives into JSON.stringify as an absent
    // key, but an explicit `null` would reach the API as "clear this field".
    const { client, calls } = authedClient(() => ({ body: { data: makePodcast() } }));
    await client.createPodcast({ title: 'Minimal' });
    expect(sentJson(calls[0])).toEqual({ title: 'Minimal' });
  });

  it('updatePodcast PATCHes only what it was given', async () => {
    const { client, calls } = authedClient(() => ({ body: { data: makePodcast() } }));
    await client.updatePodcast('507f1f77bcf86cd799439021', { title: 'Renamed' });

    expect(calls[0].url).toBe('https://api.example.test/api/podcasts/507f1f77bcf86cd799439021');
    expect(calls[0].method).toBe('PATCH');
    expect(sentJson(calls[0])).toEqual({ title: 'Renamed' });
  });

  it('setPodcastVisibility PATCHes visibility ALONE', async () => {
    // The whole risk of a convenience wrapper is that it sends more than its name
    // says. This asserts the body is exactly one field.
    const { client, calls } = authedClient(() => ({
      body: { data: makePodcast({ visibility: 'unlisted' }) },
    }));

    const show = await client.setPodcastVisibility('507f1f77bcf86cd799439021', 'unlisted');
    expect(calls[0].method).toBe('PATCH');
    expect(sentJson(calls[0])).toEqual({ visibility: 'unlisted' });
    expect(show.visibility).toBe('unlisted');
  });

  it('uploadPodcastImage POSTs multipart and sets NO Content-Type by hand', async () => {
    /**
     * The header assertion is the point. A multipart body's `Content-Type`
     * carries the boundary, which the runtime generates and no caller can write;
     * setting it by hand produces a body the server cannot parse.
     */
    const { client, calls } = authedClient(() => ({
      body: { id: 'img-1', primaryColor: '#123456' },
    }));

    const uploaded = await client.uploadPodcastImage(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      'cover.png',
    );

    expect(calls[0].url).toBe('https://api.example.test/api/images/upload');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['content-type']).toBeUndefined();
    expect(calls[0].body).toBeInstanceOf(FormData);
    expect((calls[0].body as FormData).has('image')).toBe(true);
    expect(uploaded.id).toBe('img-1');
  });

  it('createEpisodeDraft returns the episode id and its ticket', async () => {
    const { client, calls } = authedClient(() => ({
      body: {
        data: {
          episodeId: 'ep-1',
          ingestTicket: 'ticket-abc',
          expiresAt: '2026-01-02T00:00:00.000Z',
        },
      },
    }));

    const draft = await client.createEpisodeDraft('507f1f77bcf86cd799439021', {
      title: 'Drafted',
      episodeNumber: 7,
    });

    expect(calls[0].url).toBe(
      'https://api.example.test/api/podcasts/507f1f77bcf86cd799439021/episodes/draft',
    );
    expect(sentJson(calls[0])).toEqual({ title: 'Drafted', episodeNumber: 7 });
    expect(draft.ingestTicket).toBe('ticket-abc');
    expect(draft.episodeId).toBe('ep-1');
  });

  it('getEpisodeStream returns the tokenized URL', async () => {
    const { client, calls } = authedClient(() => ({
      body: { url: 'https://api.example.test/x/master.m3u8?t=abc', type: 'hls', expiresAt: 'z' },
    }));

    const stream = await client.getEpisodeStream('ep-1');
    expect(calls[0].url).toBe('https://api.example.test/api/podcasts/episodes/ep-1/stream');
    expect(stream.type).toBe('hls');
  });
});

describe('createSyraClient.ingestEpisode', () => {
  it('authenticates with the TICKET and sends no session token', async () => {
    /**
     * The property the whole draft/ingest pair exists for: this call is made by a
     * background worker that has no user session at all. A configured
     * `getAccessToken` must not turn it into a session-authenticated request,
     * and its absence must not stop it.
     */
    const { fetch, calls } = fakeFetch(() => ({ body: { data: makeSyraEpisode() } }));
    const client = createSyraClient({ baseURL: 'https://api.example.test', fetch });

    const episode = await client.ingestEpisode(
      { episodeId: 'ep-1', ingestTicket: 'ticket-abc' },
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' }),
      { duration: 1800, episodeNumber: 3 },
    );

    expect(calls[0].url).toBe('https://api.example.test/api/podcasts/episodes/ep-1/ingest');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['x-ingest-ticket']).toBe('ticket-abc');
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(episode.id).toBe('507f1f77bcf86cd799439041');

    const form = calls[0].body as FormData;
    expect(form.has('audioFile')).toBe(true);
    expect(form.get('duration')).toBe('1800');
    expect(form.get('episodeNumber')).toBe('3');
  });

  it('carries the title the finished episode earned', async () => {
    /**
     * The reason a worker calls this with an `input` at all: the draft was named
     * from the topic that was requested, and only this call has read the script.
     * The field has to survive `defined()` and the `String(value)` pass that
     * turns the input into multipart, so it is asserted on the FormData rather
     * than on the interface.
     */
    const { fetch, calls } = fakeFetch(() => ({ body: { data: makeSyraEpisode() } }));
    const client = createSyraClient({ baseURL: 'https://api.example.test', fetch });

    await client.ingestEpisode(
      { episodeId: 'ep-1', ingestTicket: 'ticket-abc' },
      new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }),
      { title: 'Why the Moon Pays the Electricity Bill', duration: 1800 },
    );

    const form = calls[0].body as FormData;
    expect(form.get('title')).toBe('Why the Moon Pays the Electricity Bill');
    // The control on the same body: another field made the same trip, so a
    // present `title` is not the only thing this could be measuring.
    expect(form.get('duration')).toBe('1800');
  });

  it('sends NO title field when the caller has no title to send', async () => {
    /**
     * An omitted title must mean "keep what the draft said", and the client is
     * the first place that can break it: `String(undefined)` is the string
     * `'undefined'`, which the server would store as the episode's name without
     * blinking. `defined()` strips the key before it can become one.
     *
     * `title: undefined` is written EXPLICITLY rather than left out, and that is
     * the whole point of the case: a key that is absent from the object never
     * reaches the `Object.entries` loop, so leaving it out would exercise
     * nothing. A worker whose own title is optional — `{ title: maybe, duration }`
     * — passes the key holding `undefined`, and that is the shape `defined()`
     * exists for.
     */
    const { fetch, calls } = fakeFetch(() => ({ body: { data: makeSyraEpisode() } }));
    const client = createSyraClient({ fetch });

    await client.ingestEpisode(
      { episodeId: 'ep-1', ingestTicket: 'ticket-abc' },
      new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }),
      { title: undefined, duration: 1800 },
    );

    const form = calls[0].body as FormData;
    expect(form.has('title')).toBe(false);
    // The control: the sibling field DID make the trip, so an absent `title` is
    // the stripping and not an input the client dropped whole.
    expect(form.get('duration')).toBe('1800');
  });

  it('still sends only the ticket when a session token IS configured', async () => {
    // The other direction of the same rule — a worker that happens to have a
    // token must not accidentally authenticate as a user here.
    const { fetch, calls } = fakeFetch(() => ({ body: { data: makeSyraEpisode() } }));
    const client = createSyraClient({ fetch, getAccessToken: () => 'tok' });

    await client.ingestEpisode(
      { episodeId: 'ep-1', ingestTicket: 'ticket-abc' },
      new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }),
    );

    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].headers['x-ingest-ticket']).toBe('ticket-abc');
  });

  it('surfaces the API’s own message when a ticket is refused', async () => {
    // A replayed or expired ticket answers 409 with a reason. The SDK must carry
    // that reason through — "409" alone does not tell a worker whether to retry.
    const { fetch } = fakeFetch(() => ({
      status: 409,
      body: { error: 'Ingest ticket already used or expired' },
    }));
    const client = createSyraClient({ fetch });

    await expect(
      client.ingestEpisode(
        { episodeId: 'ep-1', ingestTicket: 'used' },
        new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }),
      ),
    ).rejects.toThrow(/already used or expired/);
  });
});

describe('createSyraClient.abandonEpisodeIngest', () => {
  it('posts to the abandon route with the TICKET and no session token', async () => {
    /**
     * The other ending of the same capability, and it has to make the same
     * credential choice: a background worker that has no user session calls it,
     * and a configured `getAccessToken` must not turn it into a
     * session-authenticated request.
     */
    const { fetch, calls } = fakeFetch(() => ({ body: { data: makeSyraEpisode() } }));
    const client = createSyraClient({
      baseURL: 'https://api.example.test',
      fetch,
      getAccessToken: () => 'tok',
    });

    const episode = await client.abandonEpisodeIngest(
      { episodeId: 'ep-1', ingestTicket: 'ticket-abc' },
      'audio generation failed',
    );

    expect(calls[0].url).toBe('https://api.example.test/api/podcasts/episodes/ep-1/ingest/abandon');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['x-ingest-ticket']).toBe('ticket-abc');
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(sentJson(calls[0])).toEqual({ reason: 'audio generation failed' });
    expect(episode.id).toBe('507f1f77bcf86cd799439041');
  });

  it('omits the reason KEY entirely when none is given, rather than sending a blank one', async () => {
    /**
     * The server refuses a blank or `null` reason (400) and accepts an absent
     * one, so "no reason" has to reach it as an absent KEY. That is a wire fact
     * rather than a JavaScript one: `{ reason: undefined }` and `{}` stringify
     * identically, so the mutation this catches is not a dropped filter but the
     * plausible fix for a `reason` typed as `string` — `reason ?? ''`, which
     * turns every reasonless abandon into a 400.
     */
    const { fetch, calls } = fakeFetch(() => ({ body: { data: makeSyraEpisode() } }));
    const client = createSyraClient({ fetch });

    await client.abandonEpisodeIngest({ episodeId: 'ep-1', ingestTicket: 'ticket-abc' }, undefined);

    expect(sentJson(calls[0])).toEqual({});
    // The control: the ticket still made the trip, so an empty body is not this
    // call failing to be made at all.
    expect(calls[0].headers['x-ingest-ticket']).toBe('ticket-abc');
  });

  it('surfaces the API’s own message when the ticket is already spent', async () => {
    // A ticket buys one outcome. A worker that already ingested — or already
    // abandoned — gets a 409, and "409" alone does not say which.
    const { fetch } = fakeFetch(() => ({
      status: 409,
      body: { error: 'Ingest ticket already used or expired' },
    }));
    const client = createSyraClient({ fetch });

    await expect(
      client.abandonEpisodeIngest({ episodeId: 'ep-1', ingestTicket: 'used' }),
    ).rejects.toThrow(/already used or expired/);
  });
});
