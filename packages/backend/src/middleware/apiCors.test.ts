import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { apiCors, socketCors } from './apiCors';

/**
 * HTTP and Socket.IO admit the SAME browsers, from one list: the Syra app
 * origins plus the HTTPS Oxy apex family the SDK admits on its own. Anything
 * else gets no CORS headers on HTTP and is refused at the WebSocket handshake,
 * which browsers do not CORS-check at all.
 */
let server: Server;
let baseURL: string;

beforeAll(async () => {
  const app = express();
  app.use(apiCors);
  app.get('/probe', (_req, res) => res.json({ ok: true }));
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  baseURL = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function socketAdmits(origin: string | undefined): Promise<boolean> {
  return new Promise((resolve) =>
    socketCors.allowRequest({ headers: origin === undefined ? {} : { origin } }, (_error, ok) =>
      resolve(ok),
    ),
  );
}

const ADMITTED = ['https://syra.fm', 'https://mention.earth', 'https://oxy.so'];
const REFUSED = ['https://evil.example', 'https://syra.fm.evil.example', 'http://syra.fm'];

describe('API CORS', () => {
  it('echoes an admitted origin exactly, with credentials', async () => {
    for (const origin of ADMITTED) {
      const response = await fetch(`${baseURL}/probe`, { headers: { Origin: origin } });
      expect(`${origin} → ${response.headers.get('access-control-allow-origin')}`).toBe(
        `${origin} → ${origin}`,
      );
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    }
  });

  it('answers a preflight for a header Syra clients send', async () => {
    const preflight = await fetch(`${baseURL}/probe`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://syra.fm',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,x-syra-device-id',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-syra-device-id');
  });

  it('gives any other origin no CORS headers at all — never a wildcard or a reflection', async () => {
    for (const origin of REFUSED) {
      const response = await fetch(`${baseURL}/probe`, { headers: { Origin: origin } });
      expect(`${origin} → ${response.headers.get('access-control-allow-origin')}`).toBe(
        `${origin} → null`,
      );
    }
  });
});

describe('Socket.IO handshake', () => {
  it('admits the same origins as HTTP, and a native client that sends none', async () => {
    for (const origin of ADMITTED) expect(await socketAdmits(origin)).toBe(true);
    expect(await socketAdmits(undefined)).toBe(true);
  });

  it('refuses every other browser origin', async () => {
    for (const origin of REFUSED) expect(await socketAdmits(origin)).toBe(false);
  });
});
