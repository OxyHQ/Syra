/**
 * The Oxy Files background work every API instance runs (ADR 0043):
 *
 * - the reference outbox drainer (`referenceOutbox.ts`) — leased rows, so every
 *   instance shares the queue;
 * - the nightly reconciliation (`referenceReconcile.ts`) — advisory-locked, so
 *   one instance at a time, once a day per entity type;
 * - the legacy-read flusher (`legacyReads.ts`) — per instance, additive.
 */

import { startLegacyReadFlusher, stopLegacyReadFlusher } from './legacyReads';
import { startReferenceOutbox, stopReferenceOutbox } from './referenceOutbox';
import { startReferenceReconciler, stopReferenceReconciler } from './referenceReconcile';

export function startOxyFilesWorkers(): void {
  startLegacyReadFlusher();
  startReferenceOutbox();
  startReferenceReconciler();
}

export async function stopOxyFilesWorkers(): Promise<void> {
  stopReferenceOutbox();
  stopReferenceReconciler();
  await stopLegacyReadFlusher();
}
