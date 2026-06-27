import { describe, it, expect } from 'bun:test';
import { createSyraClient, SyraApiError, DEFAULT_SYRA_BASE_URL } from './index';

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

interface FetchCall {
  url: string;
}

function fakeFetch(
  handler: (url: string) => { status?: number; body: unknown },
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url });
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

// ── searchTracks ──────────────────────────────────────────────────────────────

describe('createSyraClient.searchTracks', () => {
  it('calls /api/search with category=tracks and the limit, returns preview-available tracks', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        results: {
          tracks: [
            makeTrack({ id: '507f1f77bcf86cd799439011', previewAvailable: true }),
            makeTrack({ id: '507f1f77bcf86cd799439012', previewAvailable: false }),
          ],
        },
      },
    }));

    const client = createSyraClient({ baseURL: 'https://api.example.test', fetch });
    const tracks = await client.searchTracks('hello', { limit: 10 });

    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe('507f1f77bcf86cd799439011');

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/search');
    expect(url.searchParams.get('q')).toBe('hello');
    expect(url.searchParams.get('category')).toBe('tracks');
    expect(url.searchParams.get('limit')).toBe('10');
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
    const tracks = await client.searchTracks('x');
    expect(tracks).toHaveLength(1);
  });

  it('returns an empty array when results.tracks is absent', async () => {
    const { fetch } = fakeFetch(() => ({ body: {} }));
    const client = createSyraClient({ fetch });
    expect(await client.searchTracks('x')).toEqual([]);
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
