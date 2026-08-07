/**
 * `contributor_standings` and `contributor_strikes` — the repeat-infringer
 * record of an ORDINARY Oxy account.
 *
 * Separate from `catalog_entities`' own strike columns on purpose: an artist's
 * strikes are about a catalogue they own, a contributor's are about recordings
 * they attached to somebody else's page. Somebody who is both has a row here
 * AND an artist profile, and each is struck for what it did.
 */

import { eq, sql } from 'drizzle-orm';
import { descNullsLast } from '../catalog/containers';
import { getDb, type DbOrTransaction } from '../postgres';
import { contributorStandings, contributorStrikes } from '../schema/creators';

export type ContributorStandingRow = typeof contributorStandings.$inferSelect;
export type ContributorStrikeRow = typeof contributorStrikes.$inferSelect;

/**
 * The row for one account, creating it if this is the first time the account
 * has needed one.
 *
 * An upsert rather than a read-then-insert: the first strike is also the first
 * time the account is heard of, and two takedowns landing at once would both
 * see no row. `onConflictDoUpdate` with a no-op-ish set rather than
 * `onConflictDoNothing`, because `DO NOTHING` returns no row on conflict and
 * this call has to come back with the standing either way.
 */
export async function ensureContributorStanding(
  db: DbOrTransaction,
  oxyUserId: string
): Promise<ContributorStandingRow> {
  const [standing] = await db
    .insert(contributorStandings)
    .values({ oxyUserId })
    .onConflictDoUpdate({
      target: contributorStandings.oxyUserId,
      set: { oxyUserId },
    })
    .returning();

  return standing;
}

/** The account's current standing, or undefined when it has never been struck. */
export async function findContributorStanding(
  oxyUserId: string
): Promise<ContributorStandingRow | undefined> {
  const [standing] = await getDb()
    .select()
    .from(contributorStandings)
    .where(eq(contributorStandings.oxyUserId, oxyUserId))
    .limit(1);

  return standing;
}

/** One account's strikes, newest first — the record a reviewer or an appeal reads. */
export async function listContributorStrikes(
  standingId: string
): Promise<ContributorStrikeRow[]> {
  return getDb()
    .select()
    .from(contributorStrikes)
    .where(eq(contributorStrikes.contributorStandingId, standingId))
    // `descNullsLast`, matching `contributor_strikes_contributor_standing_id_idx`'s
    // own `created_at DESC NULLS LAST` — see `db/catalog/containers.ts`'s helper
    // for why a NOT NULL column still needs the explicit spelling.
    .orderBy(descNullsLast(contributorStrikes.createdAt));
}

export async function insertContributorStrike(
  db: DbOrTransaction,
  input: { contributorStandingId: string; reason: string; trackId?: string; createdAt: Date }
): Promise<void> {
  await db.insert(contributorStrikes).values({
    contributorStandingId: input.contributorStandingId,
    reason: input.reason,
    trackId: input.trackId,
    createdAt: input.createdAt,
  });
}

/**
 * Add one to the counter and stamp the time, in the DATABASE.
 *
 * `strike_count = strike_count + 1` rather than a read, an increment in
 * JavaScript and a write back: the Mongo version loaded the document, pushed
 * onto its array and saved, so two takedowns resolved concurrently could both
 * read 2 and both write 3 — a repeat infringer one strike short of the
 * threshold, silently. The returned count is the one the row actually holds.
 */
export async function incrementStrikeCount(
  db: DbOrTransaction,
  standingId: string,
  now: Date
): Promise<number> {
  const [updated] = await db
    .update(contributorStandings)
    .set({
      strikeCount: sql`${contributorStandings.strikeCount} + 1`,
      lastStrikeAt: now,
    })
    .where(eq(contributorStandings.id, standingId))
    .returning({ strikeCount: contributorStandings.strikeCount });

  return updated.strikeCount;
}

/** Block the PUBLIC contribution path. The private locker is a separate question. */
export async function disableContributorUploads(
  db: DbOrTransaction,
  standingId: string
): Promise<void> {
  await db
    .update(contributorStandings)
    .set({ uploadsDisabled: true })
    .where(eq(contributorStandings.id, standingId));
}

/**
 * Terminate an account as a repeat infringer — ONCE.
 *
 * `terminated = false` stays in the WHERE, so a replayed takedown cannot
 * re-terminate: the caller reads "did this call cause the transition" off
 * whether a row came back, and cascading the consequences twice would take the
 * account's locker down twice and notify them twice for one event.
 */
export async function terminateContributor(
  db: DbOrTransaction,
  standingId: string,
  reason: string,
  now: Date
): Promise<boolean> {
  const terminated = await db
    .update(contributorStandings)
    .set({ terminated: true, terminatedAt: now, terminationReason: reason, uploadsDisabled: true })
    .where(
      sql`${contributorStandings.id} = ${standingId} and ${contributorStandings.terminated} = false`
    )
    .returning({ id: contributorStandings.id });

  return terminated.length === 1;
}
