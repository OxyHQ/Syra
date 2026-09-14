import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { startPlatformActivity } from './platformActivity';

describe('Syra ecosystem activity', () => {
  it('does not register local AWS storage users without an explicit producer flag', () => {
    const savedFlag = process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED;
    const savedRegion = process.env.AWS_REGION;
    try {
      process.env.AWS_REGION = 'us-west-2';
      delete process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED;
      expect(startPlatformActivity(() => true)).toBeUndefined();
      for (const value of ['false', '1', 'TRUE']) {
        process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED = value;
        expect(startPlatformActivity(() => true)).toBeUndefined();
      }
    } finally {
      if (savedFlag === undefined) delete process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED;
      else process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED = savedFlag;
      if (savedRegion === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = savedRegion;
    }
  });
  it('publishes actual media requests without a dashboard viewer and withdraws the process at shutdown', async () => {
    const previousFetch = globalThis.fetch;
    const saved = { ...process.env };
    const publications: Array<{ path: string; body: unknown }> = [];
    process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED = 'true';
    process.env.AWS_REGION = 'us-west-2';
    process.env.OXY_API_URL = 'https://collector.example.test';
    process.env.OXY_SERVICE_API_KEY = 'test-key';
    process.env.OXY_SERVICE_API_SECRET = 'test-secret';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      publications.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify(path === '/auth/service-token' ? { token: 'test-token', expiresIn: 3600 } : { ok: true }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    let traffic: ReturnType<typeof startPlatformActivity> = undefined;
    try {
      traffic = startPlatformActivity(() => true);
      expect(traffic).toBeDefined();
      const response = new EventEmitter();
      traffic!.observeHttp({ path: '/api/stream/private-track-id', headers: { 'cf-ray': 'anonymous-MAD' } }, response, () => {});
      response.emit('finish');
      await traffic!.stop();
      const batch = publications.find(item => item.path === '/internal/activity')?.body as Array<Record<string, unknown>>;
      expect(batch).toHaveLength(2);
      expect(batch.map(event => [event.service, event.direction, event.scope, event.activityType])).toEqual([
        ['syra', 'inbound', 'external', 'media'], ['syra', 'outbound', 'external', 'media'],
      ]);
      expect(batch[0].sourceRegion).toBe('edge-mad');
      expect(batch[1].targetRegion).toBe('edge-mad');
      expect(JSON.stringify(batch)).not.toMatch(/private-track-id|test-secret/);
      const members = publications.filter(item => item.path === '/internal/activity/infrastructure').map(item => item.body as Record<string, unknown>);
      expect(members[0]).toMatchObject({ service: 'syra', region: 'us-west-2', removed: false });
      expect(members.at(-1)).toMatchObject({ service: 'syra', removed: true });
    } finally {
      await traffic?.stop();
      globalThis.fetch = previousFetch;
      for (const key of ['OXY_ECOSYSTEM_ACTIVITY_ENABLED', 'AWS_REGION', 'OXY_API_URL', 'OXY_SERVICE_API_KEY', 'OXY_SERVICE_API_SECRET']) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    }
  });
});
