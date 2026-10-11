import { expect, test } from 'bun:test';
import { onRequest } from '../functions/_middleware';

test('Pages middleware preserves static responses and failures', async () => {
  const response = new Response('studio script', {
    headers: { 'content-type': 'application/javascript' },
  });
  const context = { next: async () => response };
  expect(await onRequest(context)).toBe(response);
  expect(await response.text()).toBe('studio script');
  const failure = new Error('Pages asset failure');
  context.next = async () => {
    throw failure;
  };
  await expect(onRequest(context)).rejects.toBe(failure);
});
