import { expect, test } from 'bun:test';
import { onRequest } from '../functions/_middleware';

test('Pages middleware preserves static responses and failures without configured telemetry', async () => {
  const response = new Response('studio script', { headers: { 'content-type': 'application/javascript' } });
  const context = {
    request: new Request('https://studio.syra.fm/assets/main.js'),
    env: {},
    waitUntil() { throw new Error('disabled telemetry scheduled work'); },
    next: async () => response,
  };
  expect(await onRequest(context)).toBe(response);
  expect(await response.text()).toBe('studio script');
  const failure = new Error('Pages asset failure');
  context.next = async () => { throw failure; };
  await expect(onRequest(context)).rejects.toBe(failure);
});

test('both deployed Pages hosts publish real media operations at their serving PoP', async () => {
  const previousFetch = globalThis.fetch;
  const batches: Array<Array<Record<string, unknown>>> = [];
  const pending: Promise<unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/auth/service-token') return Response.json({ token: 'test-token', expiresIn: 3600 });
    batches.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    for (const host of ['syra.fm', 'studio.syra.fm']) {
      const request = new Request(`https://${host}/assets/private-artwork.webp`);
      Object.defineProperty(request, 'cf', { value: { colo: 'MAD' } });
      const original = new Response('private-media', { headers: { 'content-type': 'image/webp' } });
      const response = await onRequest({
        request,
        env: { OXY_EDGE_ACTIVITY_ENABLED: 'true', OXY_EDGE_ACTIVITY_API_KEY: 'test-key', OXY_EDGE_ACTIVITY_API_SECRET: 'test-secret' },
        waitUntil(promise) { pending.push(promise); },
        next: async () => original,
      });
      expect(response).toBe(original);
      expect(await response.text()).toBe('private-media');
    }
    await Promise.all(pending);
    expect(batches.flat().map(event => [event.service, event.region, event.direction, event.activityType])).toEqual([
      ['syra', 'edge-mad', 'inbound', 'media'], ['syra', 'edge-mad', 'outbound', 'media'],
      ['syra', 'edge-mad', 'inbound', 'media'], ['syra', 'edge-mad', 'outbound', 'media'],
    ]);
    expect(JSON.stringify(batches)).not.toMatch(/private-|test-secret|studio\.syra/);
  } finally { globalThis.fetch = previousFetch; }
});
