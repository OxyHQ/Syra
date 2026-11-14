import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { OxyServices } from '@oxy.so/core';
import type { Server } from 'bun';
import { syraForOxySession, createSyraClient } from '../../packages/sdk';

const token = (sub: string) =>
  `e30.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
const a = token('a');
const b = token('b');
let server: Server<unknown>;
let oxy: OxyServices;
let client: ReturnType<typeof syraForOxySession>;
let revoked = false;
let redirect: string | undefined;
const requests: Array<{ account: string | null; path: string }> = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const path = new URL(request.url).pathname;
      const bearer = request.headers.get('authorization');
      const account = bearer === `Bearer ${a}` ? 'a' : bearer === `Bearer ${b}` ? 'b' : null;
      requests.push({ account, path });
      if (path === '/api/podcasts/public-cards')
        return Response.json({ items: [], unavailableIds: ['show-1'] });
      if (redirect) return Response.redirect(redirect, 307);
      if (revoked || !account) return Response.json({ error: 'unauthorized' }, { status: 401 });
      return Response.json({ data: [{ id: `show-${account}`, title: `Private ${account}` }] });
    },
  });
});
beforeEach(() => {
  revoked = false;
  redirect = undefined;
  requests.length = 0;
  oxy = new OxyServices({ baseURL: server.url.origin });
  oxy.session.setAccessToken(a);
  client = syraForOxySession(oxy, { baseURL: server.url.origin });
});
afterEach(() => {
  client.dispose();
});
afterAll(() => server.stop(true));

describe('Syra shared linked session transport', () => {
  it('calls a private method without reading or duplicating a bearer callback and follows account switches', async () => {
    expect((await client.listMyPodcasts())[0].id).toBe('show-a');
    oxy.session.setAccessToken(b);
    expect((await client.listMyPodcasts())[0].id).toBe('show-b');
    expect(requests.map((request) => request.account)).toEqual(['a', 'b']);
  });
  it('does not serve cached private data after the receiver revokes access', async () => {
    await client.listMyPodcasts();
    revoked = true;
    await expect(client.listMyPodcasts()).rejects.toThrow();
  });
  it('does not leak a bearer across HTTP redirects', async () => {
    let leaked = 0;
    const other = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        leaked++;
        return Response.json({ data: [] });
      },
    });
    redirect = other.url.href;
    try {
      await expect(client.listMyPodcasts()).rejects.toThrow();
      expect(leaked).toBe(0);
    } finally {
      other.stop(true);
    }
  });
  it('disposes the linked client without disposing the shared account', async () => {
    client.dispose();
    await expect(client.listMyPodcasts()).rejects.toThrow();
    expect(oxy.http.getAccessToken()).toBe(a);
  });
  it('keeps a public-only read off the linked account', async () => {
    expect((await client.getPublicPodcastCards(['show-1'])).unavailableIds).toEqual(['show-1']);
    expect(requests.map(({ account }) => account)).toEqual([null]);
    expect(oxy.http.getAccessToken()).toBe(a);
  });
  it('preserves the external token callback and rejects ambiguous mixed authority', async () => {
    const external = createSyraClient({ baseURL: server.url.origin, getAccessToken: () => b });
    expect((await external.listMyPodcasts())[0].id).toBe('show-b');
    expect(() => createSyraClient({ transport: { fetch }, getAccessToken: () => a })).toThrow(
      'cannot be combined',
    );
  });
});
