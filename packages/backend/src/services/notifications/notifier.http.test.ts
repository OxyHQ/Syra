import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { OxyServer } from '@oxy.so/core/server';
import { connectDb, clearDb, disconnectDb } from '../../test/postgres';
import { notifyUser } from './notifier';

let api: ReturnType<typeof Bun.serve>;
let oxy: OxyServer;
let denied = false;
let redirected = false;
let duplicate = false;
let minted = 0;
const received: Record<string, unknown>[] = [];
const input = {
  recipientId: 'listener-a',
  actorId: 'listener-a',
  event: 'upload.expiring' as const,
  entityId: 'upload-1',
  title: '1 uploaded file expiring',
  message: 'Play it to keep it.',
};

beforeAll(async () => {
  await connectDb();
  api = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/challenge')) return Response.json({ nonce: 'fixture' });
      if (path === '/auth/service-token/workload') {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.protocolVersion).toBe(2);
        expect(body.audience ?? 'oxy-api').toBe('oxy-api');
        expect(body).not.toHaveProperty('scopes');
        expect(body).not.toHaveProperty('apiKey');
        minted++;
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          token: `e30.${Buffer.from(JSON.stringify({ exp: now + 300 })).toString('base64url')}.fixture`,
          expiresIn: 300,
        });
      }
      expect(path).toBe('/notifications');
      expect(request.headers.get('authorization')).toStartWith('Bearer ');
      expect(request.headers.get('x-oxy-user-id')).toBeNull();
      received.push((await request.json()) as Record<string, unknown>);
      if (denied) return Response.json({ error: 'workload_revoked' }, { status: 403 });
      if (duplicate)
        return Response.json({ error: { code: 'conflict', message: 'dup' } }, { status: 409 });
      if (redirected)
        return new Response(null, {
          status: 307,
          headers: { location: 'https://other.invalid/leak' },
        });
      return Response.json({ notification: { id: 'n-1' } }, { status: 201 });
    },
  });
  oxy = new OxyServer({
    baseURL: api.url.origin,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIA_TEST',
      SecretAccessKey: 'fixture',
      Token: 'temporary',
    }),
  });
});
beforeEach(() => {
  denied = false;
  redirected = false;
  duplicate = false;
  received.length = 0;
});
afterEach(clearDb);
afterAll(async () => {
  oxy.dispose();
  api.stop(true);
  await disconnectDb();
});

test('oxy.notifications.create delivers once, as the workload, with the exact system request', async () => {
  expect(await notifyUser(input, oxy.notifications)).toEqual({ emitted: true });
  expect(await notifyUser(input, oxy.notifications)).toEqual({
    emitted: false,
    reason: 'duplicate',
  });
  expect(received).toEqual([
    {
      recipientId: 'listener-a',
      actorId: 'listener-a',
      type: 'system',
      entityId: 'upload-1',
      entityType: 'app',
      title: '1 uploaded file expiring',
      message: 'Play it to keep it.',
    },
  ]);
  expect(minted).toBe(1);
});
test('a 409 from Oxy is its own duplicate guard answering, so it counts as delivered', async () => {
  duplicate = true;
  expect(await notifyUser(input, oxy.notifications)).toEqual({ emitted: true });
  expect(received).toHaveLength(1);
});
test('revoked workload is a delivery failure, never a key or user fallback', async () => {
  denied = true;
  expect(await notifyUser(input, oxy.notifications)).toEqual({ emitted: false, reason: 'failed' });
  expect(received).toHaveLength(1);
});
test('redirect cannot forward service authority to another endpoint', async () => {
  redirected = true;
  expect(await notifyUser(input, oxy.notifications)).toEqual({ emitted: false, reason: 'failed' });
  expect(received).toHaveLength(1);
});
