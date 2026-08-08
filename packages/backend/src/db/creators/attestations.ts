/**
 * `contribution_attestations` — the evidence that makes a contributed
 * recording a contribution.
 *
 * One row per published track, and the row outlives the object it describes on
 * purpose: `track_id` is `ON DELETE restrict`, so deleting a track a signature
 * names forces an explicit decision rather than silently taking the evidence
 * with it.
 *
 * Four modules read these rows (`artists.controller`, `artistProfile`,
 * `takedown`, `uploads.controller`) and exactly one writes them
 * (`uploads.controller`'s `publishContribution`). Every read below returns ids
 * or the uploader — never `ip`, `userAgent` or the `rawTags*` block, which are
 * PROTECTED and therefore absent from any row type this module hands out.
 */

import { eq, inArray } from 'drizzle-orm';
import type { ProvenanceMarker } from '@syra/shared-types';
import { getDb, type DbOrTransaction } from '../postgres';
import {
  contributionAttestationProvenanceMarkers,
  contributionAttestations,
} from '../schema/creators';

/** Who signed for one published recording, if anybody did. */
export async function findAttestationUploader(trackId: string): Promise<string | undefined> {
  const [attestation] = await getDb()
    .select({ uploaderOxyUserId: contributionAttestations.uploaderOxyUserId })
    .from(contributionAttestations)
    .where(eq(contributionAttestations.trackId, trackId))
    .limit(1);

  return attestation?.uploaderOxyUserId;
}

/** Every recording one account contributed — compliance's termination cascade. */
export async function findContributedTrackIds(uploaderOxyUserId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ trackId: contributionAttestations.trackId })
    .from(contributionAttestations)
    .where(eq(contributionAttestations.uploaderOxyUserId, uploaderOxyUserId));

  return rows.map((row) => row.trackId);
}

/** What a contribution panel needs to know about one signed recording. */
export interface AttestationSummary {
  uploaderOxyUserId: string;
  acceptedAt: Date;
}

/**
 * Which of these tracks were contributed, by whom, and when they were signed for.
 *
 * A `Map` rather than a list because both callers ask per track — and the two
 * ask for different halves of it, so it returns both rather than being split in
 * two queries that would read the same rows twice. `artistProfile` wants only
 * the key set; `artists.controller`'s contribution panel renders the uploader
 * and the date.
 *
 * Both `ip`/`userAgent` and the `rawTags*` block are PROTECTED and absent here,
 * which is the whole reason this is a named projection rather than a row read.
 */
export async function findAttestationsByTrackIds(
  trackIds: readonly string[]
): Promise<Map<string, AttestationSummary>> {
  if (trackIds.length === 0) return new Map();

  const rows = await getDb()
    .select({
      trackId: contributionAttestations.trackId,
      uploaderOxyUserId: contributionAttestations.uploaderOxyUserId,
      acceptedAt: contributionAttestations.acceptedAt,
    })
    .from(contributionAttestations)
    .where(inArray(contributionAttestations.trackId, [...trackIds]));

  return new Map(
    rows.map((row) => [
      row.trackId,
      { uploaderOxyUserId: row.uploaderOxyUserId, acceptedAt: row.acceptedAt },
    ])
  );
}

export interface RecordAttestationInput {
  trackId: string;
  uploaderOxyUserId: string;
  /** The exact wording agreed to, verbatim — a later copy edit must not change a past signature. */
  statement: string;
  acceptedAt: Date;
  ip?: string;
  userAgent?: string;
  provenanceReportScore?: number;
  provenanceReportVerdict?: 'clean' | 'suspect' | 'commercial';
  provenanceMarkers?: readonly ProvenanceMarker[];
  /**
   * `RawTagDump`'s three fields — and NOT a `format`, which the fourth column
   * carries and nothing has ever produced. `extractMetadata` does not emit one,
   * so writing it would be inventing a value; see `schema/creators.ts` on the
   * columns whose write half was never connected.
   */
  rawTags?: {
    json: string;
    truncated: boolean;
    originalByteLength: number;
  };
}

/**
 * Record one signature, with the screening result that was current when it was
 * given.
 *
 * The row and its markers are ONE logical write, so the caller passes a
 * transaction handle: an attestation with no evidence of what it was signed
 * against proves nothing, and proving something is the only reason it exists.
 */
export async function recordAttestation(
  db: DbOrTransaction,
  input: RecordAttestationInput
): Promise<string> {
  const [attestation] = await db
    .insert(contributionAttestations)
    .values({
      trackId: input.trackId,
      uploaderOxyUserId: input.uploaderOxyUserId,
      statement: input.statement,
      acceptedAt: input.acceptedAt,
      ip: input.ip,
      userAgent: input.userAgent,
      provenanceReportScore: input.provenanceReportScore,
      provenanceReportVerdict: input.provenanceReportVerdict,
      rawTagsJson: input.rawTags?.json,
      rawTagsTruncated: input.rawTags?.truncated,
      rawTagsOriginalByteLength: input.rawTags?.originalByteLength,
    })
    .returning({ id: contributionAttestations.id });

  const markers = input.provenanceMarkers ?? [];
  if (markers.length > 0) {
    await db.insert(contributionAttestationProvenanceMarkers).values(
      markers.map((marker, position) => ({
        contributionAttestationId: attestation.id,
        position,
        code: marker.code,
        weight: marker.weight,
        detail: marker.detail,
      }))
    );
  }

  return attestation.id;
}
