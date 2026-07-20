import { useCallback, useEffect, useState } from 'react';
import { useOxy } from '@oxyhq/services';

/**
 * Bounded gate over the Oxy session, used by every identity-sensitive screen.
 *
 * `useOxy().isPrivateApiPending` is unbounded — it can stay `true` forever in
 * three real situations: a cold boot that never concludes, an authenticated
 * user whose token refresh keeps failing, and any consumer mounted outside
 * `OxyProvider` (the context default is `isPrivateApiPending: true`). Gating a
 * skeleton on that flag directly therefore renders a skeleton with no way out.
 *
 * This hook wraps it in a time bound: the session gets
 * {@link AUTH_RESOLUTION_TIMEOUT_MS} to reach a terminal state, after which the
 * gate reports `'timed-out'` — a terminal status screens render as an error
 * with a retry, never as another skeleton. `retry()` re-arms the bound and
 * gives the session a fresh window.
 *
 * It also owns {@link CatalogIdentity}, the `guest` / `auth` React Query
 * cache-key suffix that keeps a guest cold-boot response from populating the
 * authenticated cache.
 */

/**
 * How long the Oxy session may stay unresolved before the gate gives up. Long
 * enough to cover a cold boot on a slow connection, short enough that a session
 * that will never resolve does not hold a screen hostage.
 */
const AUTH_RESOLUTION_TIMEOUT_MS = 10_000;

/** React Query cache-key suffix separating guest reads from authenticated ones. */
export type CatalogIdentity = 'auth' | 'guest';

/**
 * Terminal states are `'guest'`, `'authenticated'` and `'timed-out'`;
 * `'resolving'` is the only state a screen may render as a skeleton.
 */
export type AuthGateStatus = 'resolving' | 'guest' | 'authenticated' | 'timed-out';

export interface AuthGate {
  status: AuthGateStatus;
  /** The session is still resolving and the time bound has not elapsed. */
  isResolving: boolean;
  /** Terminal: the session never resolved within the bound. Render an error. */
  isTimedOut: boolean;
  /** The session reached a terminal identity — catalog reads may run. */
  isResolved: boolean;
  /** Resolved with a usable access token: private API calls are allowed. */
  canUsePrivateApi: boolean;
  /** A session exists, even if its token is not usable yet. */
  isAuthenticated: boolean;
  /** Cache-key suffix for identity-sensitive catalog queries. */
  catalogIdentity: CatalogIdentity;
  /** Re-arms the time bound, giving the session another window to resolve. */
  retry: () => void;
}

export function useAuthGate(): AuthGate {
  const { canUsePrivateApi, isAuthenticated, isPrivateApiPending } = useOxy();
  const [attempt, setAttempt] = useState(0);
  const [hasTimedOut, setHasTimedOut] = useState(false);

  // The one place a timer is legitimate: bounding an external flag the app does
  // not control. Each pending episode gets its own timer; the cleanup that ends
  // the episode — the session resolving, `retry` bumping `attempt`, or unmount
  // — is what clears the timed-out verdict, so a session that goes pending
  // again later starts from a full, fresh window rather than an expired one.
  useEffect(() => {
    if (!isPrivateApiPending) {
      return;
    }
    const timer = setTimeout(() => setHasTimedOut(true), AUTH_RESOLUTION_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      setHasTimedOut(false);
    };
  }, [isPrivateApiPending, attempt]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  // A session that resolves after the bound elapsed clears `hasTimedOut` on the
  // next effect run; pairing it with `isPrivateApiPending` keeps that one render
  // in between from flashing the timed-out branch.
  const isTimedOut = hasTimedOut && isPrivateApiPending;
  const status: AuthGateStatus = isTimedOut
    ? 'timed-out'
    : isPrivateApiPending
      ? 'resolving'
      : canUsePrivateApi
        ? 'authenticated'
        : 'guest';

  return {
    status,
    isResolving: status === 'resolving',
    isTimedOut,
    isResolved: status === 'authenticated' || status === 'guest',
    canUsePrivateApi,
    isAuthenticated,
    catalogIdentity: canUsePrivateApi ? 'auth' : 'guest',
    retry,
  };
}
