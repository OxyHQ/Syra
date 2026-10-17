import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { createPublicPodcastCardsRouter } from '../routes/publicPodcastCards.routes';
import { trustLoadBalancer } from './trustProxy';

let server: Server;
let baseURL: string;

beforeAll(async () => {
  const app = express();
  trustLoadBalancer(app);
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  app.use('/cards', createPublicPodcastCardsRouter(undefined, 1));
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

/** What the ALB forwards: the client's own header, then the peer it saw. */
const viaAlb = (spoofed: string) => ({ 'X-Forwarded-For': `${spoofed}, 203.0.113.7` });

describe('trust proxy', () => {
  it('keys a client by the address the load balancer appended, not one it sent', async () => {
    const response = await fetch(`${baseURL}/ip`, { headers: viaAlb('198.51.100.1') });
    expect(await response.json()).toEqual({ ip: '203.0.113.7' });

    const post = (spoofed: string) =>
      fetch(`${baseURL}/cards`, { method: 'POST', headers: viaAlb(spoofed), body: '{' });
    expect((await post('198.51.100.1')).status).toBe(400);
    expect((await post('198.51.100.2')).status).toBe(429);
  });
});
