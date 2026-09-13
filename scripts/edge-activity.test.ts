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
