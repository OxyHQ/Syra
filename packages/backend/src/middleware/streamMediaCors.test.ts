import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { streamMediaCors } from './streamMediaCors';

// Exercise the middleware through a real Express app so we cover the actual
// ServerResponse semantics (header removal, `res.vary`, the 204 short-circuit)
// rather than a hand-rolled mock.
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();

  // Mimic the global credentialed CORS in server.ts, which sets this header on
  // every response. The middleware under test must strip it so `*` is valid.
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    next();
  });

  app.get('/media', streamMediaCors, (_req, res) => {
    res.status(200).send('payload');
  });
  app.options('/media', streamMediaCors, (_req, res) => {
    // Reached only if the middleware fails to short-circuit the preflight.
    res.status(200).send('should-not-run');
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('streamMediaCors', () => {
  it('emits permissive, non-credentialed CORS on a cross-origin GET', async () => {
    const res = await fetch(`${baseUrl}/media`, {
      headers: { Origin: 'https://www.gstatic.com' },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('payload');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('Range, Content-Type');
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'Content-Length, Content-Range, Accept-Ranges, Content-Type',
    );
    expect(res.headers.get('vary')?.split(',').map((v) => v.trim())).toContain('Origin');
  });

  it('short-circuits an OPTIONS preflight with 204 and the CORS headers', async () => {
    const res = await fetch(`${baseUrl}/media`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://www.gstatic.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'range',
      },
    });

    expect(res.status).toBe(204);
    // The downstream OPTIONS handler must never run.
    expect(await res.text()).toBe('');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
  });
});
