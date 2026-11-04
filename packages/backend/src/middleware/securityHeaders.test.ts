import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { securityHeaders } from './securityHeaders';

let server: Server;
let baseURL: string;

beforeAll(async () => {
  const app = express();
  app.use(securityHeaders);
  app.get('/cover.jpg', (_req, res) => res.type('image/jpeg').send(Buffer.from([0xff, 0xd8])));
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

it('hardens every response without blocking cross-origin media loads', async () => {
  const response = await fetch(`${baseURL}/cover.jpg`);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  // syra.fm renders api.syra.fm images and HLS in <img>/<audio>; `same-origin`
  // (Helmet's default) would make the browser refuse every one of them.
  expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
});
