import { OxyServices } from '@oxy.so/core';

const mockOxy = new OxyServices({
  baseURL: 'https://identity.example',
  enableRetry: false,
  enableCache: false,
});
jest.mock('@/lib/oxyServices', () => ({ oxyServices: mockOxy }));
jest.mock('@/config', () => ({ API_URL: 'https://syra.example' }));

const { api } = require('@/utils/api') as typeof import('@/utils/api');

it('keeps the session when Syra returns an authority outage and recovers on retry', async () => {
  const payload = Buffer.from(
    JSON.stringify({ userId: 'alice', sessionId: 'session-a', exp: 2_000_000_000 }),
  ).toString('base64url');
  const bearer = `e30.${payload}.fixture`;
  const originalFetch = globalThis.fetch;
  let unavailable = true;
  globalThis.fetch = jest.fn(async () => {
    const status = unavailable ? 503 : 200;
    const body = unavailable
      ? { code: 'SESSION_VALIDATION_ERROR', message: 'Session validation failed' }
      : { data: { ok: true } };
    return {
      ok: status === 200,
      status,
      statusText: status === 503 ? 'Service Unavailable' : 'OK',
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
  try {
    mockOxy.session.setAccessToken(bearer);
    const epoch = mockOxy.http.getSessionEpoch();
    await expect(
      api.get('/playlists', undefined, { cache: false, deduplicate: false, retry: false }),
    ).rejects.toMatchObject({ status: 503 });
    expect(mockOxy.session.accessToken).toBe(bearer);
    expect(mockOxy.http.getSessionEpoch()).toBe(epoch);
    unavailable = false;
    await expect(
      api.get('/playlists', undefined, { cache: false, deduplicate: false, retry: false }),
    ).resolves.toEqual({ data: { ok: true } });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  } finally {
    mockOxy.dispose();
    globalThis.fetch = originalFetch;
  }
});
