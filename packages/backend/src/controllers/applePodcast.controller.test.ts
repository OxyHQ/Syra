import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const importFeed = mock(async (_feedUrl: string) => ({ podcast: { id: 'unset' } }));
import type { Request, Response } from 'express';

let openApplePodcast: (req: Request, res: Response) => Promise<void>;

beforeAll(async () => {
  mock.module('../services/podcasts/podcastImportService', () => ({ importFeed }));
  mock.module('../config/env', () => ({ env: { FRONTEND_URL: 'https://syra.fm/' } }));
  ({ openApplePodcast } = await import('./applePodcast.controller.js'));
});

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

const realFetch = globalThis.fetch;
const appleLookupWith = (results: unknown[]) => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
};

describe('openApplePodcast', () => {
  beforeEach(() => {
    importFeed.mockClear();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('answers with the Syra show for the Apple feed, imported or already known', async () => {
    appleLookupWith([{ collectionId: 1234567890, feedUrl: 'https://feeds.example/show.xml' }]);
    importFeed.mockResolvedValueOnce({ podcast: { id: 'show_1' } } as never);
    const res = response();

    await openApplePodcast({ params: { collectionId: '1234567890' } } as never, res as never);

    expect(importFeed).toHaveBeenCalledWith('https://feeds.example/show.xml');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      data: { podcastId: 'show_1', url: 'https://syra.fm/podcasts/show_1' },
    });
  });

  it('refuses a collection id that is not numeric, before asking Apple', async () => {
    const calls = appleLookupWith([]);
    const res = response();

    await openApplePodcast({ params: { collectionId: '../etc' } } as never, res as never);

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('answers 404 when Apple has no podcast with that id', async () => {
    appleLookupWith([]);
    const res = response();

    await openApplePodcast({ params: { collectionId: '1234567890' } } as never, res as never);

    expect(res.statusCode).toBe(404);
    expect(importFeed).not.toHaveBeenCalled();
  });
});
