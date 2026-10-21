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

/**
 * The test client connects from loopback — a private peer, which is what the
 * ALB is to the task — so each case is the header the ALB would forward.
 */
const CLIENT = '203.0.113.7';
/** An address inside Cloudflare's published 172.64.0.0/13. */
const CLOUDFLARE_EDGE = '172.70.1.2';

async function ipFor(forwardedFor: string): Promise<string> {
  const response = await fetch(`${baseURL}/ip`, { headers: { 'X-Forwarded-For': forwardedFor } });
  return ((await response.json()) as { ip: string }).ip;
}

describe('trust proxy', () => {
  it('DNS-only (grey): the address the load balancer appended is the client', async () => {
    expect(await ipFor(CLIENT)).toBe(CLIENT);
  });

  it('proxied (orange): the client is the entry before Cloudflare’s edge, not the edge', async () => {
    expect(await ipFor(`${CLIENT}, ${CLOUDFLARE_EDGE}`)).toBe(CLIENT);
  });

  it('never believes an entry the client wrote', async () => {
    // Grey: the client prepends a forged address; the ALB appends the real one.
    expect(await ipFor(`198.51.100.1, ${CLIENT}`)).toBe(CLIENT);
    // Orange: forged entries to the left of the client Cloudflare saw.
    expect(await ipFor(`198.51.100.1, ${CLIENT}, ${CLOUDFLARE_EDGE}`)).toBe(CLIENT);
    // A non-Cloudflare address claiming to be the hop before the ALB is the client.
    expect(await ipFor(`${CLIENT}, 198.51.100.9`)).toBe('198.51.100.9');
  });

  it('keys the public-cards limiter by that client, whatever it forges', async () => {
    const post = (forwardedFor: string) =>
      fetch(`${baseURL}/cards`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': forwardedFor },
        body: '{',
      });
    expect((await post(`198.51.100.1, ${CLIENT}, ${CLOUDFLARE_EDGE}`)).status).toBe(400);
    // A fresh forged entry is the same client and the same bucket.
    expect((await post(`198.51.100.2, ${CLIENT}, ${CLOUDFLARE_EDGE}`)).status).toBe(429);
    // Control: a different client behind the same edge has its own bucket.
    expect((await post(`203.0.113.8, ${CLOUDFLARE_EDGE}`)).status).toBe(400);
  });
});
