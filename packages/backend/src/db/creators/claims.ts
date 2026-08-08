/**
 * `artist_claims` — somebody asking to be recognised as a contributed artist.
 *
 * A contributed profile is built from the tags of a file a stranger uploaded,
 * so a claim NEVER auto-grants: it is stored `pending` and a human resolves it.
 * That is why there is no "auto-approved" status and never will be.
 *
 * Nothing here joins to the catalogue. The GRANT itself — the only write that
 * hands out ownership — is a conditional `UPDATE catalog_entities` and lives in
 * `artists.controller`, where it belongs: it is a catalog write with a claim as
 * its precondition, not a claim write.
 */

import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { descNullsLast } from '../catalog/containers';
import type { ArtistClaim } from '@syra/shared-types';
import { getDb } from '../postgres';
import { artistClaims } from '../schema/creators';

export type ArtistClaimRow = typeof artistClaims.$inferSelect;

/**
 * `artist_claims` protects no columns — a claim is the claimant's own words
 * about themselves, and every field is served back to them — so the row type is
 * the whole row and this is still an explicit allowlist rather than a spread.
 */
export function toArtistClaimDto(row: ArtistClaimRow): ArtistClaim {
  return {
    id: row.id,
    artistId: row.artistId,
    oxyUserId: row.oxyUserId,
    evidence: row.evidence,
    status: row.status,
    resolvedAt: row.resolvedAt?.toISOString(),
    resolvedBy: row.resolvedBy ?? undefined,
    resolutionNote: row.resolutionNote ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Open a claim.
 *
 * No read-then-write: the partial unique index
 * (`artist_claims_artist_id_oxy_user_id_pending_key`, `WHERE status =
 * 'pending'`) is the authority on "one OPEN claim per claimant per artist", and
 * a check before the insert leaves exactly the window two taps land in. The
 * `23505` IS the answer, which is why this throws it onward rather than
 * swallowing it — the caller turns that one constraint name into a 409.
 */
export async function insertArtistClaim(input: {
  artistId: string;
  oxyUserId: string;
  evidence: string;
}): Promise<ArtistClaimRow> {
  const [claim] = await getDb()
    .insert(artistClaims)
    .values({
      artistId: input.artistId,
      oxyUserId: input.oxyUserId,
      evidence: input.evidence,
      status: 'pending',
    })
    .returning();

  return claim;
}

export async function findArtistClaimById(id: string): Promise<ArtistClaimRow | undefined> {
  const [claim] = await getDb()
    .select()
    .from(artistClaims)
    .where(eq(artistClaims.id, id))
    .limit(1);

  return claim;
}

/** One claimant's own claims, newest first. */
export async function listArtistClaimsByClaimant(
  oxyUserId: string,
  limit: number
): Promise<ArtistClaimRow[]> {
  return getDb()
    .select()
    .from(artistClaims)
    .where(eq(artistClaims.oxyUserId, oxyUserId))
    // `descNullsLast`, matching `artist_claims_oxy_user_id_created_at_idx`'s own
    // `created_at DESC NULLS LAST`. Plain `desc()` is semantically identical on
    // a NOT NULL column and asks for a DIFFERENT pathkey, which costs the
    // ordering its index scan — see `db/catalog/containers.ts`'s helper.
    .orderBy(descNullsLast(artistClaims.createdAt))
    .limit(limit);
}

/** The review queue for one status, oldest first — a claim waiting is a person waiting. */
export async function listArtistClaimsByStatus(
  status: ArtistClaimRow['status'],
  limit: number,
  offset: number
): Promise<{ claims: ArtistClaimRow[]; total: number }> {
  const [claims, [counted]] = await Promise.all([
    getDb()
      .select()
      .from(artistClaims)
      .where(eq(artistClaims.status, status))
      .orderBy(asc(artistClaims.createdAt))
      .limit(limit)
      .offset(offset),
    getDb()
      .select({ total: sql<number>`count(*)::int` })
      .from(artistClaims)
      .where(eq(artistClaims.status, status)),
  ]);

  return { claims, total: counted?.total ?? 0 };
}

/**
 * Resolve one claim, but only while it is still pending.
 *
 * `status = 'pending'` stays in the WHERE rather than being checked before the
 * write: two reviewers working the queue at once must not both resolve the same
 * row, and the loser has to see that it was already answered. Returns undefined
 * when nothing matched, which is exactly that case.
 */
export async function resolvePendingArtistClaim(input: {
  id: string;
  status: 'approved' | 'rejected';
  resolvedBy: string;
  resolvedAt: Date;
  resolutionNote?: string;
}): Promise<ArtistClaimRow | undefined> {
  const [resolved] = await getDb()
    .update(artistClaims)
    .set({
      status: input.status,
      resolvedAt: input.resolvedAt,
      resolvedBy: input.resolvedBy,
      ...(input.resolutionNote !== undefined ? { resolutionNote: input.resolutionNote } : {}),
    })
    .where(and(eq(artistClaims.id, input.id), eq(artistClaims.status, 'pending')))
    .returning();

  return resolved;
}

/**
 * Close every OTHER open claim on a profile that has just been granted.
 *
 * They are unanswerable now — the artist has an owner, so no reviewer can
 * approve them — and leaving them pending would both lie about the queue and
 * hold the partial unique index's slot, so a rejected claimant could never
 * appeal later.
 */
export async function rejectOtherPendingClaims(input: {
  artistId: string;
  exceptClaimId: string;
  resolvedBy: string;
  resolvedAt: Date;
  resolutionNote: string;
}): Promise<number> {
  const rejected = await getDb()
    .update(artistClaims)
    .set({
      status: 'rejected',
      resolvedAt: input.resolvedAt,
      resolvedBy: input.resolvedBy,
      resolutionNote: input.resolutionNote,
    })
    .where(
      and(
        eq(artistClaims.artistId, input.artistId),
        eq(artistClaims.status, 'pending'),
        ne(artistClaims.id, input.exceptClaimId)
      )
    )
    .returning({ id: artistClaims.id });

  return rejected.length;
}
