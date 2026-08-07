import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import {
  claimSuppression,
  isEventDisabled,
  type SyraNotificationEvent,
} from '../../db/user/notifications';
import { getOxyServiceToken } from './oxyServiceToken';

/**
 * The ONE chokepoint for emitting a Syra notification.
 *
 * Every trigger goes through `notifyUser`. Nothing else calls Oxy's notification API, so
 * the preference checks, the anti-spam rules and the failure handling exist in exactly one
 * place and cannot be forgotten by the next trigger someone adds.
 *
 * Delivery is Oxy's: `POST /notifications` (service-token + `notifications:write` scope)
 * persists the notification and emits it in real time. Syra deliberately does NOT store
 * notifications or register push tokens — those live upstream, and a second registry is
 * what the shared-SDK rule exists to prevent.
 *
 * Fire-and-forget by contract: a failure here is logged and swallowed. A notification that
 * cannot be delivered must never fail the action that triggered it — nobody should lose an
 * episode import because a push endpoint was down.
 *
 * ## The two suppression rules are one statement each, in `db/user/notifications.ts`
 *
 * `isEventDisabled` and `claimSuppression` moved there with their tables. The
 * claim is still an INSERT rather than a read-then-write — that is what makes it
 * race-free — but it no longer treats every duplicate key as "already notified":
 * an EXPIRED claim is now taken over by the same statement. The Mongo version
 * could not see `expiresAt` at all, so a row its TTL monitor had not yet reaped
 * kept suppressing; that module's doc comment carries the full reasoning.
 */

/** How long an exact-entity suppression record is kept. Long enough to outlive re-imports. */
const EXACT_SUPPRESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Default coalescing window: at most one notification per group per user per 6 hours. */
const DEFAULT_COALESCE_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface NotifyInput {
  /** Oxy user id of the person being notified. */
  recipientId: string;
  /** Oxy user id (or stable entity id) of whoever/whatever caused this. */
  actorId: string;
  event: SyraNotificationEvent;
  /** The Syra entity this is about — track, album, episode, room, playlist. */
  entityId: string;
  entityType: string;
  title?: string;
  message?: string;
  data?: Record<string, unknown>;
  /**
   * Optional coalescing group. When set, at most one notification is emitted per
   * (recipient, event, group) per `coalesceWindowMs`. This is what stops a show that
   * publishes several episodes at once from producing several pushes.
   */
  coalesceGroupId?: string;
  coalesceWindowMs?: number;
}

/** Why an emission did not happen — returned so triggers and tests can assert on it. */
export type NotifyResult =
  | { emitted: true }
  | { emitted: false; reason: 'event-disabled' | 'duplicate' | 'coalesced' | 'failed' };

/**
 * Injectable seam for the Oxy service token.
 *
 * Exists so tests can drive the suppression logic without real credentials, rather than
 * globally mocking the token module — a global module mock leaks into every other test
 * file in the same process, which silently broke the credential-absent test that is the
 * whole point of failing honestly.
 */
export interface NotifierDeps {
  getToken: () => Promise<string>;
}

/**
 * Emit one notification, subject to every suppression rule.
 *
 * Order matters: the cheapest local checks run before anything touches the network.
 */
export async function notifyUser(
  input: NotifyInput,
  deps?: NotifierDeps,
): Promise<NotifyResult> {
  const resolvedDeps: NotifierDeps = deps ?? { getToken: getOxyServiceToken };
  try {
    if (await isEventDisabled(input.recipientId, input.event)) {
      return { emitted: false, reason: 'event-disabled' };
    }

    // Exact dedupe: this user has already been told about this exact entity.
    const exactKey = `${input.event}:${input.entityId}`;
    if (!(await claimSuppression(input.recipientId, exactKey, EXACT_SUPPRESSION_TTL_MS))) {
      return { emitted: false, reason: 'duplicate' };
    }

    // Coalescing: this user already heard about this group recently.
    if (input.coalesceGroupId) {
      const groupKey = `${input.event}:group:${input.coalesceGroupId}`;
      const window = input.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
      if (!(await claimSuppression(input.recipientId, groupKey, window))) {
        return { emitted: false, reason: 'coalesced' };
      }
    }

    await postNotification(input, resolvedDeps);
    return { emitted: true };
  } catch (error) {
    // Swallow: a notification must never break the action that triggered it.
    logger.error('[notifier] failed to emit notification', {
      event: input.event,
      entityId: input.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { emitted: false, reason: 'failed' };
  }
}

/**
 * POST the notification to Oxy.
 *
 * A 409 from Oxy means its own duplicate guard (`recipientId`+`actorId`+`type`+`entityId`)
 * already holds one — that is a successful outcome, not an error, so it is not logged as one.
 */
async function postNotification(input: NotifyInput, deps: NotifierDeps): Promise<void> {
  const token = await deps.getToken();

  const response = await fetch(`${env.OXY_API_URL}/notifications`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      recipientId: input.recipientId,
      actorId: input.actorId,
      type: input.event,
      entityId: input.entityId,
      entityType: input.entityType,
      title: input.title,
      message: input.message,
      data: input.data,
    }),
  });

  if (response.status === 409) {
    return;
  }

  if (!response.ok) {
    throw new Error(`Oxy notification create failed: ${response.status} ${await response.text()}`);
  }
}
