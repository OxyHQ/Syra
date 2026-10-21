/**
 * The Oxy Files background work every API instance runs (ADR 0043):
 *
 * - the reference outbox drainer (`referenceOutbox.ts`) — leased rows, so every
 *   instance shares the queue;
 * - the nightly reconciliation (`referenceReconcile.ts`) — advisory-locked, so
 *   one instance at a time, once a day per entity type.
 */

import { startReferenceOutbox, stopReferenceOutbox } from './referenceOutbox';
import { startReferenceReconciler, stopReferenceReconciler } from './referenceReconcile';

export function startOxyFilesWorkers(): void {
  startReferenceOutbox();
  startReferenceReconciler();
}

export function stopOxyFilesWorkers(): void {
  stopReferenceOutbox();
  stopReferenceReconciler();
}
