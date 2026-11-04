import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { OxyApiError } from '@oxy.so/core';
import { count } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { notificationPreferences, notificationSuppressions } from '../../db/schema/user';

import { notifyUser, type NotifierDeps, type OxyNotificationRequest } from './notifier';

// The real transport is covered by `notifier.http.test.ts`; suppression tests inject delivery only.
const RECIPIENT = 'oxy-listener-1';

/** Requests handed to `oxy.notifications.create`. */
let sent: OxyNotificationRequest[] = [];
/** What the next `create` does instead of succeeding. */
let nextFailure: Error | null = null;

const deps: NotifierDeps = {
  create: async (request) => {
    if (nextFailure) {
      const failure = nextFailure;
      nextFailure = null;
      throw failure;
    }
    sent.push(request);
    return {} as Awaited<ReturnType<NotifierDeps['create']>>;
  },
};

beforeAll(connectDb);
afterAll(disconnectDb);
beforeEach(() => {
  sent = [];
  nextFailure = null;
});
afterEach(clearDb);

function notify(input: Parameters<typeof notifyUser>[0]) {
  return notifyUser(input, deps);
}

/** How many suppression claims exist, of any age. */
async function suppressionCount(): Promise<number> {
  const [row] = await getDb().select({ value: count() }).from(notificationSuppressions);
  return row.value;
}

/** An expiry notice: the owner is told about their own files, coalesced per owner. */
function expiryInput(uploadId: string, groupId = 'owner-group') {
  return {
    recipientId: RECIPIENT,
    actorId: RECIPIENT,
    event: 'upload.expiring' as const,
    entityId: uploadId,
    title: '1 uploaded file expiring',
    message: 'Play it to keep it.',
    coalesceGroupId: groupId,
  };
}

describe('notifyUser', () => {
  it('sends an upload notice to Oxy as a system notification about the owner', async () => {
    const result = await notify(expiryInput('upload-1'));

    expect(result).toEqual({ emitted: true });
    expect(sent).toEqual([
      {
        recipientId: RECIPIENT,
        actorId: RECIPIENT,
        type: 'system',
        entityId: 'upload-1',
        entityType: 'app',
        title: '1 uploaded file expiring',
        message: 'Play it to keep it.',
      },
    ]);
  });

  /**
   * Oxy's notification types are a closed set and none of them is "a show you
   * follow published". Sending one anyway is refused by Oxy's request
   * validation, so it is not sent — and, the point of this test, it claims
   * nothing: a suppression for a notification nobody received would silence the
   * event once Oxy can carry it.
   */
  it('sends nothing and claims nothing for an event Oxy has no type for', async () => {
    const result = await notify({
      recipientId: RECIPIENT,
      actorId: 'show-1',
      event: 'episode.published',
      entityId: 'ep-1',
      title: 'A Show',
      message: 'An Episode',
      coalesceGroupId: 'show-1',
    });

    expect(result).toEqual({ emitted: false, reason: 'undeliverable' });
    expect(sent).toHaveLength(0);
    expect(await suppressionCount()).toBe(0);
  });

  it('never notifies twice about the same entity', async () => {
    await notify(expiryInput('upload-1', 'group-a'));
    const second = await notify(expiryInput('upload-1', 'group-b'));

    expect(second).toEqual({ emitted: false, reason: 'duplicate' });
    expect(sent).toHaveLength(1);
  });

  // THE case this system exists to prevent: a clear-out that touches a whole library must
  // produce ONE notification, not one per file. Getting this wrong costs the push permission
  // permanently — users do not grant it a second time.
  it('coalesces 40 notices in one group into a single notification', async () => {
    const results = [];
    for (let i = 0; i < 40; i += 1) {
      results.push(await notify(expiryInput(`upload-${i}`)));
    }

    expect(sent).toHaveLength(1);
    expect(results.filter((r) => r.emitted)).toHaveLength(1);
    expect(results.filter((r) => !r.emitted && r.reason === 'coalesced')).toHaveLength(39);
  });

  it('still notifies about a different group during the coalescing window', async () => {
    await notify(expiryInput('upload-1', 'group-a'));
    const other = await notify(expiryInput('upload-2', 'group-b'));

    expect(other).toEqual({ emitted: true });
    expect(sent).toHaveLength(2);
  });

  it('does not emit an event the user turned off, and makes no network call', async () => {
    await getDb()
      .insert(notificationPreferences)
      .values({ oxyUserId: RECIPIENT, disabledEvents: ['upload.expiring'] });

    const result = await notify(expiryInput('upload-1'));

    expect(result).toEqual({ emitted: false, reason: 'event-disabled' });
    expect(sent).toHaveLength(0);
    // A disabled event must not even claim a suppression key — re-enabling should not
    // leave the user silently suppressed for everything that happened while it was off.
    expect(await suppressionCount()).toBe(0);
  });

  it('emits for an event the user has NOT disabled', async () => {
    await getDb()
      .insert(notificationPreferences)
      .values({ oxyUserId: RECIPIENT, disabledEvents: ['upload.removed'] });

    expect(await notify(expiryInput('upload-1'))).toEqual({ emitted: true });
  });

  /**
   * The behaviour `schema/user.ts` describes: a claim that treated any
   * duplicate key as "already notified" would keep suppressing past its own
   * deadline until the sweep reaped it. `on conflict … where expires_at <= now()`
   * takes an expired claim over instead, which makes the coalescing window exact
   * and leaves the sweep as pure housekeeping.
   *
   * BOTH keys are expired, not just the exact one: `notifyUser` claims
   * `<event>:<entityId>` and then `<event>:group:<groupId>`, so expiring only the
   * first would win that claim and then collide on the group key, and the test
   * would report `coalesced` for a reason that has nothing to do with what it is
   * asserting.
   */
  it('re-arms once a claim has expired, rather than waiting for the sweep', async () => {
    expect(await notify(expiryInput('upload-1'))).toEqual({ emitted: true });
    expect(await suppressionCount()).toBe(2);

    await getDb()
      .update(notificationSuppressions)
      .set({ expiresAt: new Date(Date.now() - 1_000) });

    // Same user, same entity, same group — and it emits, because every claim
    // standing in the way is past its own deadline.
    expect(await notify(expiryInput('upload-1'))).toEqual({ emitted: true });
    expect(sent).toHaveLength(2);

    // Claimed, not duplicated: the rows were taken over in place.
    expect(await suppressionCount()).toBe(2);

    // And the fresh claims suppress again, so re-arming did not disable the rule.
    expect(await notify(expiryInput('upload-1'))).toEqual({
      emitted: false,
      reason: 'duplicate',
    });
  });

  /**
   * A claim stands only for a notification Oxy accepted. Before, the claims were
   * taken and KEPT when the send failed, so one Oxy outage silenced that entity
   * for 30 days and its group for the whole window — nobody was told, and every
   * retry answered `duplicate`.
   */
  it('reports a failed send without throwing, and releases what it claimed', async () => {
    nextFailure = new OxyApiError('unavailable', { status: 503, code: 'UNAVAILABLE' });

    // The caller must survive: a sweep or a takedown cannot fail because a
    // notification could not be delivered.
    expect(await notify(expiryInput('upload-1'))).toEqual({ emitted: false, reason: 'failed' });
    expect(await suppressionCount()).toBe(0);

    // So the next trigger for the same entity and group is delivered.
    expect(await notify(expiryInput('upload-1'))).toEqual({ emitted: true });
    expect(sent).toHaveLength(1);
  });

  it('releasing a failed claim leaves a live claim on another key alone', async () => {
    expect(await notify(expiryInput('upload-1', 'group-a'))).toEqual({ emitted: true });

    nextFailure = new Error('network down');
    expect(await notify(expiryInput('upload-2', 'group-b'))).toEqual({
      emitted: false,
      reason: 'failed',
    });

    // upload-1's two claims stand; upload-2's were given back.
    expect(await suppressionCount()).toBe(2);
    expect(await notify(expiryInput('upload-1', 'group-c'))).toEqual({
      emitted: false,
      reason: 'duplicate',
    });
  });

  it('treats Oxy 409 duplicate as delivered, and keeps the claim', async () => {
    nextFailure = new OxyApiError('Duplicate notification', { status: 409, code: 'CONFLICT' });

    // Oxy dedupes on recipient+actor+type+entity itself. Its 409 means the notification
    // already exists, which is the outcome we wanted.
    expect(await notify(expiryInput('upload-1'))).toEqual({ emitted: true });
    expect(await suppressionCount()).toBe(2);
  });
});
