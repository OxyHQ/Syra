import { describe, expect, it } from 'bun:test';
import { createSyraClient, SyraApiError, SyraResponseError } from './index';
import { checkResponse, checkRow, episodeSummary, podcastSummary, trackSummary } from './responses';

/**
 * What the client promises about a response, pinned without Zod. These are the
 * guarantees callers built on when the checks were Zod schemas — the parity test
 * beside this one proves the two agree; this one says what "agree" means.
 */

const track = {
  id: 't1',
  title: 'Song',
  artistName: 'Artist',
  duration: 180,
  previewAvailable: true,
};

describe('a valid response', () => {
  it('comes back with exactly the fields the type names', () => {
    expect(checkResponse(trackSummary, track, 'getTrack')).toStrictEqual(track);
  });

  it('keeps nested objects, checked the same way', () => {
    const podcast = {
      id: 'p1',
      title: 'Show',
      imageSizes: { small: { url: '/api/images/a', width: 64 } },
      visibility: 'unlisted' as const,
    };
    expect(checkResponse(podcastSummary, podcast, 'getPodcast')).toStrictEqual(podcast);
  });

  it('leaves an optional field the response did not send absent, not `undefined`', () => {
    const checked = checkResponse(trackSummary, track, 'getTrack');
    expect('albumName' in checked).toBe(false);
  });
});

describe('extra fields', () => {
  it('are dropped, at every level', () => {
    const checked = checkResponse(
      podcastSummary,
      {
        id: 'p1',
        title: 'Show',
        ownerId: 'server-only',
        imageSizes: { large: { url: '/api/images/b', blurhash: 'x' }, huge: { url: '/c' } },
      },
      'getPodcast',
    );
    expect(checked).toStrictEqual({
      id: 'p1',
      title: 'Show',
      imageSizes: { large: { url: '/api/images/b' } },
    });
  });

  it('cannot rewrite the prototype of what comes back', () => {
    const checked = checkResponse(
      trackSummary,
      JSON.parse('{"id":"t","title":"x","artistName":"a","duration":1,"__proto__":{"evil":1}}'),
      'getTrack',
    ) as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(checked)).toBe(Object.prototype);
    expect(checked.evil).toBeUndefined();
  });
});

describe('an invalid response', () => {
  const invalid: Array<[string, unknown]> = [
    ['a missing required field', { ...track, title: undefined }],
    ['a required field of the wrong type', { ...track, duration: '180' }],
    ['`null` for an optional field', { ...track, albumName: null }],
    ['a non-finite number', { ...track, duration: Number.POSITIVE_INFINITY }],
    ['a nested field of the wrong type', { ...track, coverArtSizes: { small: { url: 1 } } }],
    ['an array where an object belongs', [track]],
    ['`null`', null],
    ['`undefined` (an envelope without the object)', undefined],
  ];

  for (const [name, input] of invalid) {
    it(`is refused: ${name}`, () => {
      expect(() => checkResponse(trackSummary, input, 'getTrack')).toThrow(SyraResponseError);
      expect(checkRow(trackSummary, input)).toBeUndefined();
    });
  }

  it('is refused for an enum value outside the set', () => {
    const episode = { id: 'e', podcastId: 'p', title: 'x', status: 'deleted' };
    expect(() => checkResponse(episodeSummary, episode, 'getEpisode')).toThrow(SyraResponseError);
  });

  it('says which method and which field', () => {
    let error: unknown;
    try {
      checkResponse(trackSummary, { ...track, coverArtSizes: { small: { url: 1 } } }, 'getTrack');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SyraResponseError);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SyraApiError);
    const responseError = error as SyraResponseError;
    expect(responseError.name).toBe('SyraResponseError');
    expect(responseError.method).toBe('getTrack');
    expect(responseError.path).toEqual(['coverArtSizes', 'small', 'url']);
    expect(responseError.message).toContain('coverArtSizes.small.url');
    expect(responseError.message).toContain('getTrack');
  });
});

describe('through the client', () => {
  function client(body: unknown) {
    const fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;
    return createSyraClient({ baseURL: 'https://api.example.test', fetch });
  }

  it('a single-object method rejects with SyraResponseError', async () => {
    await expect(client({ data: { podcast: { id: 'x' } } }).getPodcast('x')).rejects.toBeInstanceOf(
      SyraResponseError,
    );
  });

  it('a list method drops the bad row and keeps the rest, stripped', async () => {
    const page = await client({
      data: [
        { id: 'p1', title: 'Good', internal: true },
        { id: 'p2' },
        { id: 'p3', title: 'Also good', visibility: 'secret' },
      ],
      hasMore: false,
    }).searchPodcasts('q');
    expect(page.items).toStrictEqual([{ id: 'p1', title: 'Good' }]);
  });
});
