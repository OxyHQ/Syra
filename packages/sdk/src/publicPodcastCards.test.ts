import { describe, expect, it } from 'bun:test';
import { createSyraClient } from './client';

const card = { id: 'show', title: 'Current', showUrl: 'https://syra.fm/podcasts/show' };
function client(body: unknown, inspect?: (init?: RequestInit) => void) {
  return createSyraClient({
    getAccessToken: () => 'private-token',
    fetch: (async (_url, init) => {
      inspect?.(init);
      return Response.json(body);
    }) as unknown as typeof fetch,
  });
}
describe('public podcast reference batches', () => {
  it('deduplicates, stays anonymous and forwards cancellation', async () => {
    const controller = new AbortController();
    await expect(
      client({ items: [card], unavailableIds: ['missing'] }, (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ ids: ['show', 'missing'] });
        expect(init?.headers).not.toHaveProperty('Authorization');
        expect(init?.signal).toBe(controller.signal);
      }).getPublicPodcastCards(['show', 'show', 'missing'], { signal: controller.signal }),
    ).resolves.toEqual({ items: [card], unavailableIds: ['missing'] });
  });
  it('rejects missing, duplicate, unexpected and snapshot fields', async () => {
    for (const body of [
      { items: [], unavailableIds: [] },
      { items: [card], unavailableIds: ['show'] },
      { items: [{ ...card, id: 'other' }], unavailableIds: [] },
      { items: [{ ...card, owner: 'secret' }], unavailableIds: [] },
    ])
      await expect(client(body).getPublicPodcastCards(['show'])).rejects.toThrow();
  });
  it('rejects oversized and empty input before fetching', async () => {
    const noFetch = createSyraClient({
      fetch: (() => {
        throw new Error('must not fetch');
      }) as unknown as typeof fetch,
    });
    for (const ids of [[], Array.from({ length: 101 }, (_, i) => String(i))]) {
      await expect(noFetch.getPublicPodcastCards(ids)).rejects.not.toThrow('must not fetch');
    }
  });
  it('maps structured errors without returning old content', async () => {
    const api = createSyraClient({
      fetch: (async () =>
        Response.json(
          { error: { code: 'service_unavailable', message: 'Try later' } },
          { status: 503 },
        )) as unknown as typeof fetch,
    });
    await expect(api.getPublicPodcastCards(['show'])).rejects.toMatchObject({
      status: 503,
      code: 'service_unavailable',
    });
  });
});
