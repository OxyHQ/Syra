import { OxyApiError } from '@oxy.so/core';
import type { ServerNotificationsApi } from '@oxy.so/core/server';
import { logger } from '../../utils/logger';
import {
  claimSuppression,
  isEventDisabled,
  releaseSuppression,
  type SuppressionClaim,
  type SyraNotificationEvent,
} from '../../db/user/notifications';
import { oxy } from '../../oxyClient';

/**
 * The ONE chokepoint for emitting a Syra notification.
 *
 * Every trigger goes through `notifyUser`. Nothing else calls Oxy's notification API, so
 * the preference checks, the anti-spam rules and the failure handling exist in exactly one
 * place and cannot be forgotten by the next trigger someone adds.
 *
 * Delivery is Oxy's: `oxy.notifications.create` (workload identity) persists the
 * notification, emits it in real time and, for a `system` notification, pushes it. Syra
 * deliberately does NOT store notifications or register push tokens — those live upstream,
 * and a second registry is what the shared-SDK rule exists to prevent.
 *
 * Fire-and-forget by contract: a failure here is logged and swallowed. A notification that
 * cannot be delivered must never fail the action that triggered it — nobody should lose an
 * episode import because a push endpoint was down.
 *
 * ## The two suppression rules are one statement each, in `db/user/notifications.ts`
 *
 * `isEventDisabled` and `claimSuppression` live there with their tables. The
 * claim is an INSERT rather than a read-then-write — that is what makes it
 * race-free — but it does not treat every duplicate key as "already notified":
 * an EXPIRED claim is taken over by the same statement; that module's doc
 * comment carries the full reasoning.
 *
 * A claim only stands for a notification Oxy accepted. The claim is still taken
 * BEFORE the send (two concurrent triggers must not both decide to emit), and every
 * claim this call won is released when the send fails, so a failed delivery never
 * suppresses the next attempt.
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
  title: string;
  message: string;
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
  | {
      emitted: false;
      reason: 'event-disabled' | 'duplicate' | 'coalesced' | 'undeliverable' | 'failed';
    };

/** The request `oxy.notifications.create` takes. */
export type OxyNotificationRequest = Parameters<ServerNotificationsApi['create']>[0];

/** Delivery seam: the real one is `oxy.notifications`; tests pass a recorder. */
export type NotifierDeps = Pick<ServerNotificationsApi, 'create'>;

/**
 * How a Syra event is expressed in Oxy's notification contract, or `null` when it
 * cannot be.
 *
 * Oxy's notification types are a closed set (`OXY_NOTIFICATION_TYPES`): social
 * types a person causes (`like`, `follow`, …) and `system`, a message from an Oxy
 * service about the recipient's OWN account — the actor is the recipient, the
 * entity an opaque id in this app's namespace (`entityType: 'app'`), and the text
 * is stored and pushed. A notice about the recipient's own uploads is exactly that.
 *
 * The other Syra events are about something SOMEONE ELSE did (a show you follow
 * published, an artist released, a room started, a collaborator edited a playlist).
 * Oxy has no type for those today and refuses any other value, so they are not sent
 * rather than dressed up as a type they are not. Deciding how they reach a listener
 * is an Oxy contract change, not something this function can paper over.
 */
export function toOxyNotification(input: NotifyInput): OxyNotificationRequest | null {
  switch (input.event) {
    case 'upload.expiring':
    case 'upload.removed':
      return {
        recipientId: input.recipientId,
        actorId: input.actorId,
        type: 'system',
        entityId: input.entityId,
        entityType: 'app',
        title: input.title,
        message: input.message,
      };
    case 'episode.published':
    case 'artist.release':
    case 'room.started':
    case 'playlist.collaboration':
      return null;
  }
}

/** Events already reported as undeliverable by this process — one warning each, not one per recipient. */
const reportedUndeliverable = new Set<SyraNotificationEvent>();

/**
 * Emit one notification, subject to every suppression rule.
 *
 * Order matters: the cheapest local checks run before anything touches the network.
 */
export async function notifyUser(
  input: NotifyInput,
  deps: NotifierDeps = oxy.notifications,
): Promise<NotifyResult> {
  const request = toOxyNotification(input);
  if (!request) {
    if (!reportedUndeliverable.has(input.event)) {
      reportedUndeliverable.add(input.event);
      logger.warn('[notifier] Oxy has no notification type for this event; not sent', {
        event: input.event,
      });
    }
    return { emitted: false, reason: 'undeliverable' };
  }

  const claims: SuppressionClaim[] = [];
  try {
    if (await isEventDisabled(input.recipientId, input.event)) {
      return { emitted: false, reason: 'event-disabled' };
    }

    // Exact dedupe: this user has already been told about this exact entity.
    const exact = await claimSuppression(
      input.recipientId,
      `${input.event}:${input.entityId}`,
      EXACT_SUPPRESSION_TTL_MS,
    );
    if (!exact) {
      return { emitted: false, reason: 'duplicate' };
    }
    claims.push(exact);

    // Coalescing: this user already heard about this group recently.
    if (input.coalesceGroupId) {
      const group = await claimSuppression(
        input.recipientId,
        `${input.event}:group:${input.coalesceGroupId}`,
        input.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS,
      );
      if (!group) {
        return { emitted: false, reason: 'coalesced' };
      }
      claims.push(group);
    }

    await send(request, deps);
    return { emitted: true };
  } catch (error) {
    // Swallow: a notification must never break the action that triggered it.
    logger.error('[notifier] failed to emit notification', {
      event: input.event,
      entityId: input.entityId,
      status: error instanceof OxyApiError ? error.status : undefined,
    });
    await Promise.all(claims.map((claim) => releaseSuppression(claim))).catch((releaseError) =>
      logger.error('[notifier] could not release suppression claims after a failed send', {
        event: input.event,
        entityId: input.entityId,
        error: releaseError instanceof Error ? releaseError.message : String(releaseError),
      }),
    );
    return { emitted: false, reason: 'failed' };
  }
}

/**
 * A 409 from Oxy means its own duplicate guard (`recipientId`+`actorId`+`type`+`entityId`)
 * already holds one — that is a successful outcome, not an error, so it is not raised.
 */
async function send(request: OxyNotificationRequest, deps: NotifierDeps): Promise<void> {
  try {
    await deps.create(request);
  } catch (error) {
    if (error instanceof OxyApiError && error.status === 409) return;
    throw error;
  }
}
