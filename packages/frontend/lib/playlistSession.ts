import { useSyncExternalStore } from 'react';
import { oxyServices } from '@/lib/oxyServices';

const http = oxyServices.http;

function sessionKey(): string {
  return `${http.getSessionEpoch()}:${http.getAccessToken() ? 1 : 0}`;
}

function subscribe(notify: () => void): () => void {
  return http.addTokenChangeListener(notify);
}

/** A React snapshot which changes whenever an existing session becomes stale. */
export function usePlaylistSessionKey(): string {
  return useSyncExternalStore(subscribe, sessionKey, sessionKey);
}

/** Observe the bearer subject separately, so renders never read a mutable getter. */
export function usePlaylistSessionSubject(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => oxyServices.session.userId,
    () => null,
  );
}

/** Compare against the snapshot from the render which produced the action. */
export function isPlaylistSessionCurrent(owner: string): boolean {
  return sessionKey() === owner;
}

/** A playlist write requires both the same context and an active bearer. */
export function ownsPlaylistSession(owner: string, accountId: string | null): boolean {
  return (
    !!accountId &&
    oxyServices.session.userId === accountId &&
    !!http.getAccessToken() &&
    isPlaylistSessionCurrent(owner)
  );
}
