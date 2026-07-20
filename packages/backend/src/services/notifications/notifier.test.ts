import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { clear, connect, disconnect } from '../../test/mongo';
import { NotificationPreferenceModel } from '../../models/NotificationPreference';
import { NotificationSuppressionModel } from '../../models/NotificationSuppression';

import { notifyUser } from './notifier';

// The token is injected rather than module-mocked: bun's `mock.module` is process-global,
// so stubbing the token module here silently disabled the credential-absent test in
// oxyServiceToken.test.ts — the one test whose entire purpose is proving we fail loudly.
const testDeps = { getToken: async () => 'test-service-token' };

const RECIPIENT = 'oxy-listener-1';

/** Captured POSTs to Oxy's notification endpoint. */
let posted: Array<Record<string, unknown>> = [];
let failNextPost = false;
const realFetch = globalThis.fetch;

beforeAll(connect);
afterAll(async () => {
  globalThis.fetch = realFetch;
  await disconnect();
});

beforeEach(() => {
  posted = [];
  failNextPost = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (failNextPost) {
      throw new Error('network down');
    }
    posted.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  }) as typeof fetch;
});

afterEach(clear);

/** Always inject the stub token so no test reaches the real credential path. */
function notifyUserT(input: Parameters<typeof notifyUser>[0]) {
  return notifyUser(input, testDeps);
}

function episodeInput(episodeId: string, podcastId: string) {
  return {
    recipientId: RECIPIENT,
    actorId: podcastId,
    event: 'episode.published' as const,
    entityId: episodeId,
    entityType: 'episode',
    title: 'New episode',
    coalesceGroupId: podcastId,
  };
}

describe('notifyUser', () => {
  it('emits once for a new entity', async () => {
    const result = await notifyUserT(episodeInput('ep-1', 'show-1'));

    expect(result).toEqual({ emitted: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      recipientId: RECIPIENT,
      type: 'episode.published',
      entityId: 'ep-1',
      entityType: 'episode',
    });
  });

  it('never notifies twice about the same entity', async () => {
    await notifyUserT(episodeInput('ep-1', 'show-1'));
    const second = await notifyUserT(episodeInput('ep-1', 'show-1'));

    expect(second).toEqual({ emitted: false, reason: 'duplicate' });
    expect(posted).toHaveLength(1);
  });

  // THE case this system exists to prevent: a feed refresh that imports a show's whole
  // back catalogue must produce ONE notification, not one per episode. Getting this wrong
  // costs the push permission permanently — users do not grant it a second time.
  it('coalesces a 40-episode backfill into a single notification', async () => {
    const results = [];
    for (let i = 0; i < 40; i += 1) {
      results.push(await notifyUserT(episodeInput(`ep-${i}`, 'show-1')));
    }

    expect(posted).toHaveLength(1);
    expect(results.filter((r) => r.emitted)).toHaveLength(1);
    expect(results.filter((r) => !r.emitted && r.reason === 'coalesced')).toHaveLength(39);
  });

  it('still notifies about a different show during the coalescing window', async () => {
    await notifyUserT(episodeInput('ep-1', 'show-1'));
    const other = await notifyUserT(episodeInput('ep-2', 'show-2'));

    expect(other).toEqual({ emitted: true });
    expect(posted).toHaveLength(2);
  });

  it('does not emit an event the user turned off, and makes no network call', async () => {
    await NotificationPreferenceModel.create({
      oxyUserId: RECIPIENT,
      disabledEvents: ['episode.published'],
    });

    const result = await notifyUserT(episodeInput('ep-1', 'show-1'));

    expect(result).toEqual({ emitted: false, reason: 'event-disabled' });
    expect(posted).toHaveLength(0);
    // A disabled event must not even claim a suppression key — re-enabling should not
    // leave the user silently suppressed for everything that happened while it was off.
    expect(await NotificationSuppressionModel.countDocuments({})).toBe(0);
  });

  it('emits for an event the user has NOT disabled', async () => {
    await NotificationPreferenceModel.create({
      oxyUserId: RECIPIENT,
      disabledEvents: ['artist.release'],
    });

    expect(await notifyUserT(episodeInput('ep-1', 'show-1'))).toEqual({ emitted: true });
  });

  it('reports failure without throwing when delivery fails', async () => {
    failNextPost = true;

    // The caller must survive: an import or a room start cannot fail because a
    // notification could not be delivered.
    const result = await notifyUserT(episodeInput('ep-1', 'show-1'));

    expect(result).toEqual({ emitted: false, reason: 'failed' });
  });

  it('treats Oxy 409 duplicate as delivered, not as an error', async () => {
    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify({ error: 'Duplicate notification' }), { status: 409 }),
      { preconnect: globalThis.fetch.preconnect },
    );

    // Oxy dedupes on recipient+actor+type+entity itself. Its 409 means the notification
    // already exists, which is the outcome we wanted.
    expect(await notifyUserT(episodeInput('ep-1', 'show-1'))).toEqual({ emitted: true });
  });
});
