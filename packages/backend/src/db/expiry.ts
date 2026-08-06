/**
 * Expiry Sweep registry — the replacement for Mongo TTL indexes
 *
 * Postgres has no TTL index. Every table that needs one adds an entry here
 * rather than growing its own cleanup path. The registry stays here because
 * it would name THIS schema's own tables; the mechanism that sweeps it
 * (`sweepExpiredRows`, `sweepAllExpiredRows`, `ExpirySweepTarget`) lives in
 * `@oxyhq/db/expiry` — see that module's doc comment for the full shape and
 * for why a TTL index is a behaviour of the SOURCE that does not survive a
 * Mongo-to-Postgres port on its own.
 *
 * ## THE RULE, because it is the quietest failure in this migration
 *
 * **A TTL index is a behaviour of the SOURCE that does not survive the port.**
 * Mongo reaps; Postgres does not. A table ported without a registry entry
 * grows FOREVER — no error, no failing test, no symptom of any kind until
 * disk. It is structurally invisible because the thing doing the work was
 * never in this code to be missed: there is no deleted call site, no orphaned
 * function, nothing a reviewer diffing the port would see go absent.
 *
 * So porting a collection is not done when its schema and migration exist. If
 * its Mongoose model declares `expireAfterSeconds`, it is done only once a
 * matching entry exists here — and this registry should eventually be gated
 * by a test that WALKS the Mongoose models for `expireAfterSeconds`
 * declarations, rather than one that names tables by hand and can only fall
 * as far behind as the last time someone remembered to update it. That gate
 * has no schema to walk yet, so it is future work rather than something this
 * task can write.
 *
 * Empty today: there is no schema yet, so nothing has been ported and nothing
 * needs sweeping. `findUnsupportedExpiryColumns` (`@oxyhq/db/assert`) reads
 * the real Postgres catalogue against whatever lands here, so an entry added
 * without its supporting index fails the gate rather than silently costing a
 * full table scan on every sweep.
 */

import type { ExpirySweepTarget } from '@oxyhq/db/expiry';

/**
 * Every table that had a Mongo TTL index. A table with an expiry column but no
 * entry here is never swept.
 */
export const EXPIRY_SWEEP_TARGETS: readonly ExpirySweepTarget[] = [];
