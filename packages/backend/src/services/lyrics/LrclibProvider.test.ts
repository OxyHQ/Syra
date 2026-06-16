import { describe, it, expect } from 'bun:test';
import { LrclibProvider } from './LrclibProvider';

const TEST_BASE = 'https://lrclib.test';

type FetchResult = { status: number; body: unknown };

function makeProvider(fetchJson: (url: string) => Promise<FetchResult>): LrclibProvider {
  return new LrclibProvider({ fetchJson, apiBase: TEST_BASE });
}

const QUERY = { trackName: 'Open Road', artistName: 'Free Artist', albumName: 'Open Album', durationSec: 210 };

describe('LrclibProvider.getLyrics — synced lyrics', () => {
  it('returns synced lyrics when syncedLyrics present', async () => {
    let capturedUrl = '';
    const provider = makeProvider(async (url) => {
      capturedUrl = url;
      return {
        status: 200,
        body: { syncedLyrics: '[00:01.00] hi\n[00:02.00] yo', plainLyrics: 'hi\nyo' },
      };
    });

    const result = await provider.getLyrics(QUERY);

    expect(result).not.toBeNull();
    expect(result?.synced).toBe(true);
    expect(result?.lines).toHaveLength(2);
    expect(result?.lines[0].timeMs).toBe(1000);
    expect(result?.lines[0].text).toBe('hi');
    expect(result?.lines[1].timeMs).toBe(2000);
    expect(result?.lines[1].text).toBe('yo');
    expect(result?.plain).toBe('hi\nyo');
    expect(result?.source).toBe('lrclib');
  });

  it('request URL contains /api/get and encoded params', async () => {
    let capturedUrl = '';
    const provider = makeProvider(async (url) => {
      capturedUrl = url;
      return { status: 200, body: { syncedLyrics: '[00:01.00] x', plainLyrics: null } };
    });

    await provider.getLyrics(QUERY);

    expect(capturedUrl).toContain('/api/get');
    expect(capturedUrl).toContain('artist_name=');
    expect(capturedUrl).toContain('track_name=');
    expect(capturedUrl).toContain('album_name=');
    expect(capturedUrl).toContain('duration=210');
  });
});

describe('LrclibProvider.getLyrics — plain lyrics fallback', () => {
  it('returns synced:false with plain lines when syncedLyrics is null', async () => {
    const provider = makeProvider(async () => ({
      status: 200,
      body: { syncedLyrics: null, plainLyrics: 'just\nplain' },
    }));

    const result = await provider.getLyrics(QUERY);

    expect(result).not.toBeNull();
    expect(result?.synced).toBe(false);
    expect(result?.lines).toHaveLength(2);
    expect(result?.lines[0].timeMs).toBe(0);
    expect(result?.lines[0].text).toBe('just');
    expect(result?.lines[1].text).toBe('plain');
    expect(result?.plain).toBe('just\nplain');
    expect(result?.source).toBe('lrclib');
  });
});

describe('LrclibProvider.getLyrics — null returns', () => {
  it('returns null on 404 (track not found)', async () => {
    const provider = makeProvider(async () => ({ status: 404, body: null }));
    const result = await provider.getLyrics(QUERY);
    expect(result).toBeNull();
  });

  it('returns null when both syncedLyrics and plainLyrics are null/empty', async () => {
    const provider = makeProvider(async () => ({
      status: 200,
      body: { syncedLyrics: null, plainLyrics: null },
    }));
    const result = await provider.getLyrics(QUERY);
    expect(result).toBeNull();
  });

  it('returns null when body is malformed (no known lyrics fields)', async () => {
    const provider = makeProvider(async () => ({
      status: 200,
      body: { something: 'unexpected' },
    }));
    const result = await provider.getLyrics(QUERY);
    expect(result).toBeNull();
  });
});

describe('LrclibProvider.getLyrics — error propagation', () => {
  it('rejects on non-2xx non-404 status (e.g. 500)', async () => {
    const provider = makeProvider(async () => ({ status: 500, body: null }));
    await expect(provider.getLyrics(QUERY)).rejects.toThrow('lrclib');
  });
});

describe('LrclibProvider — metadata', () => {
  it('source is "lrclib"', () => {
    const provider = new LrclibProvider({ apiBase: TEST_BASE });
    expect(provider.source).toBe('lrclib');
  });

  it('omits album_name and duration when not provided', async () => {
    let capturedUrl = '';
    const provider = makeProvider(async (url) => {
      capturedUrl = url;
      return { status: 404, body: null };
    });

    await provider.getLyrics({ trackName: 'T', artistName: 'A' });

    expect(capturedUrl).not.toContain('album_name');
    expect(capturedUrl).not.toContain('duration');
  });
});
