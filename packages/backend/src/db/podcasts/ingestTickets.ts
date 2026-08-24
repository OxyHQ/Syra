/**
 * The redemption record of an episode ingest ticket — the half of the
 * capability that lives in Postgres.
 *
 * The token proves WHAT was granted; this table decides whether the grant is
 * still available. See `schema/podcasts.ts`'s `episode_ingest_tickets` for why
 * that decision cannot live in Redis, and `services/podcasts/ingestToken.ts` for
 * what a leaked ticket is narrowed to.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type DbOrTransaction } from '../postgres';
import { episodeIngestTickets } from '../schema/podcasts';

/** Record a freshly minted ticket, inside the caller's transaction. */
export async function insertIngestTicket(
  db: DbOrTransaction,
  values: { jti: string; episodeId: string; expiresAt: Date }
): Promise<void> {
  await db.insert(episodeIngestTickets).values(values);
}

/**
 * Claim a ticket for use, atomically. `true` means the caller now holds the one
 * redemption this ticket ever had.
 *
 * ONE statement, and that is the whole point. A read-then-write would let two
 * concurrent redemptions of the same ticket both observe `consumed_at is null`
 * and both proceed; `update … where consumed_at is null returning` is resolved
 * by the row lock, so exactly one of them gets a row back.
 *
 * Zero rows means refused, and deliberately does not say WHICH refusal it was:
 * unknown `jti`, already consumed, past its deadline, or bound to a different
 * episode. The caller cannot act on the difference and the holder of a bad
 * ticket should not learn it.
 *
 * `expires_at` is re-checked here even though the JWT carries its own `exp` and
 * has already been verified. The token is the holder's copy; the row is ours.
 */
export async function claimIngestTicket(
  db: DbOrTransaction,
  jti: string,
  episodeId: string
): Promise<boolean> {
  const claimed = await db
    .update(episodeIngestTickets)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(episodeIngestTickets.jti, jti),
        eq(episodeIngestTickets.episodeId, episodeId),
        isNull(episodeIngestTickets.consumedAt),
        sql`${episodeIngestTickets.expiresAt} > now()`
      )
    )
    .returning({ jti: episodeIngestTickets.jti });

  return claimed.length > 0;
}

/**
 * Hand a claimed ticket back after a redemption that did NOT take effect.
 *
 * The compensating half of {@link claimIngestTicket}, and the reason the claim
 * happens before the S3 upload rather than after: claiming first is what makes a
 * replay arriving mid-upload lose, and releasing on a HANDLED failure is what
 * stops a transient S3 error from destroying a 24-hour capability a background
 * worker cannot re-obtain without a user session.
 *
 * The asymmetry is intentional and is the safe direction: a handled error
 * releases, a CRASH does not. An unreleased ticket costs one wasted draft; a
 * ticket released by a process that then died holding the audio would be a
 * capability nobody is accounting for.
 */
export async function releaseIngestTicket(jti: string): Promise<void> {
  await getDb()
    .update(episodeIngestTickets)
    .set({ consumedAt: null })
    .where(eq(episodeIngestTickets.jti, jti));
}
