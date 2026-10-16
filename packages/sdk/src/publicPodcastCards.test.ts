import { describe, expect, it } from 'bun:test';
import { createSyraClient } from './client';
import { SyraApiError, SyraResponseError } from './errors';

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
  it('drops fields the card does not name', async () => {
    const batch = await client({
      items: [{ ...card, owner: 'secret' }],
      unavailableIds: [],
    }).getPublicPodcastCards(['show']);
    expect(batch.items).toStrictEqual([card]);
  });
  it('rejects a batch that does not account for every id once, or carries a non-http URL', async () => {
    for (const body of [
      { items: [], unavailableIds: [] },
      { items: [card], unavailableIds: ['show'] },
      { items: [{ ...card, id: 'other' }], unavailableIds: [] },
      { items: [{ ...card, showUrl: 'javascript:alert(1)' }], unavailableIds: [] },
    ])
      await expect(client(body).getPublicPodcastCards(['show'])).rejects.toBeInstanceOf(
        SyraResponseError,
      );
  });
  it('rejects empty, oversized and malformed input before fetching', async () => {
    const noFetch = createSyraClient({
      fetch: (() => {
        throw new Error('must not fetch');
      }) as unknown as typeof fetch,
    });
    for (const ids of [[], Array.from({ length: 101 }, (_, i) => String(i)), [' padded']]) {
      await expect(noFetch.getPublicPodcastCards(ids)).rejects.not.toThrow('must not fetch');
    }
  });
  it('maps structured errors to SyraApiError.code', async () => {
    const api = createSyraClient({
      fetch: (async () =>
        Response.json(
          { error: { code: 'service_unavailable', message: 'Try later' } },
          { status: 503 },
        )) as unknown as typeof fetch,
    });
    const error = await api.getPublicPodcastCards(['show']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyraApiError);
    expect(error).toMatchObject({ status: 503, code: 'service_unavailable' });
  });
});
