import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { catalogEntities } from '../../db/schema/catalog';
import { checkUploadPermission } from '../strikeService';
import { canContributePublicly } from './contributorStrikes';

/**
 * May this uploader publish this recording to the PUBLIC catalog, and under whose
 * profile?
 *
 * The single authority for the contribution matrix. The uploads controller asks
 * this and does not re-derive any part of it — the whole point of the matrix is
 * that "who is allowed to attach a file to an artist page" has exactly one
 * answer, in one place, and that a later caller cannot accidentally implement a
 * looser version of it.
 *
 * |   | Relationship to the resolved artist          | Result                            |
 * |---|----------------------------------------------|-----------------------------------|
 * | A | the uploader owns (or has claimed) it        | ordinary creator upload           |
 * | B | somebody ELSE owns it                        | blocked unless `acceptsContributions` |
 * | C | it exists unclaimed, or was created as a stub| allowed, with screening + attestation |
 * | — | no artist could be resolved at all           | REJECTED, with a reason code      |
 *
 * The last row is a rejection and not a silent downgrade to the private locker.
 * Without an artist there is no attribution, no profile for the real artist to
 * claim later, and nobody to address a takedown to — so the uploader is told what
 * the file is missing rather than quietly having their intent changed. (A PRIVATE
 * upload with no artist stays perfectly valid; that is a different path and this
 * predicate has no say in it.)
 *
 * Case B is the impersonation surface the whole design turns on: the real artist
 * is present on Syra, and attaching a stranger's file to their page is exactly
 * the risk. It is theirs to open, so `acceptsContributions` defaults to false and
 * only they can flip it.
 */

/**
 * Machine-readable rejection codes.
 *
 * Stable identifiers, never sentences — the client switches on these to decide
 * what to offer next (the locker, a different artist, an appeal), and the human
 * message beside them is free to be rewritten or translated without breaking that.
 */
export const CONTRIBUTION_REJECTION_CODES = {
  /** No artist could be resolved from the file, and the public path needs one. */
  artistUnresolved: 'artist_unresolved',
  /** An artist id was supplied but no such artist exists. */
  artistNotFound: 'artist_not_found',
  /** Case B: the artist is claimed by somebody else and is not accepting contributions. */
  artistContributionsClosed: 'artist_contributions_closed',
  /** The target artist cannot receive uploads — copyright strikes or termination. */
  artistUploadsDisabled: 'artist_uploads_disabled',
  /**
   * The UPLOADER is barred, not the destination. Distinct from
   * `artist_uploads_disabled` because the two say opposite things to the person
   * reading them: one means "this profile is closed", the other means "you are".
   */
  contributorBlocked: 'contributor_blocked',
} as const;

export type ContributionRejectionCode =
  (typeof CONTRIBUTION_REJECTION_CODES)[keyof typeof CONTRIBUTION_REJECTION_CODES];

export interface PublicContributionRequest {
  /** The Oxy user attempting to publish. */
  uploaderOxyUserId: string;
  /**
   * The artist resolved from the file, when resolution reached HIGH confidence.
   *
   * Absent means "no artist", which is a rejection — a medium-confidence name is
   * displayable text, not an identity, and must not be passed here.
   */
  artistId?: string;
}

export type PublicContributionDecision =
  /** Case A — the uploader's own profile; the ordinary creator upload path. */
  | { allowed: true; mode: 'owner'; artistId: string; requiresAttestation: false }
  /** Cases B (opened) and C — somebody else's or nobody's profile. */
  | { allowed: true; mode: 'contribution'; artistId: string; requiresAttestation: true }
  | {
      allowed: false;
      code: ContributionRejectionCode;
      /** Human-readable, safe to show the uploader. */
      message: string;
      /** The HTTP status this rejection should be answered with. */
      status: number;
    };

/**
 * Decide whether a public contribution may proceed.
 *
 * Reads the artist ONCE and gates on `checkUploadPermission` before branching on
 * ownership, so a terminated or strike-disabled artist is refused whoever is
 * uploading — including their own owner, and including a contributed stub that
 * collected strikes from earlier contributions.
 */
export async function evaluatePublicContribution(
  request: PublicContributionRequest,
): Promise<PublicContributionDecision> {
  const { uploaderOxyUserId, artistId } = request;

  /**
   * The UPLOADER's own standing, checked FIRST and before anything about the
   * destination.
   *
   * A repeat infringer must be refused whatever they aim at — including their own
   * artist profile, and including an artist who opened their page to
   * contributions. Checking the destination first would let a terminated account
   * keep publishing anywhere the destination happened to be permissive, which is
   * precisely the hole a repeat-infringer policy exists to close.
   */
  if (!(await canContributePublicly(uploaderOxyUserId))) {
    return {
      allowed: false,
      code: CONTRIBUTION_REJECTION_CODES.contributorBlocked,
      message:
        'Your account cannot publish to the public catalogue because of repeated ' +
        'copyright complaints.',
      status: 403,
    };
  }

  if (!artistId) {
    return {
      allowed: false,
      code: CONTRIBUTION_REJECTION_CODES.artistUnresolved,
      message:
        'This file does not say who the artist is, so it cannot be published to the ' +
        'public catalog. Add the artist to the file\'s tags or pick one on the review ' +
        'screen — or keep the file in your private library instead.',
      status: 422,
    };
  }

  // `type = 'artist'` is written out: `catalog_entities` holds persons in the
  // same table, and a person id supplied as `artistId` must be "no such artist"
  // rather than a row whose ownership columns happen to be readable.
  const [artist] = await getDb()
    .select({
      ownerOxyUserId: catalogEntities.ownerOxyUserId,
      claimedByOxyUserId: catalogEntities.claimedByOxyUserId,
      acceptsContributions: catalogEntities.acceptsContributions,
    })
    .from(catalogEntities)
    .where(and(eq(catalogEntities.id, artistId), eq(catalogEntities.type, 'artist')))
    .limit(1);

  if (!artist) {
    return {
      allowed: false,
      code: CONTRIBUTION_REJECTION_CODES.artistNotFound,
      message: 'That artist profile does not exist.',
      status: 404,
    };
  }

  if (!(await checkUploadPermission(artistId))) {
    return {
      allowed: false,
      code: CONTRIBUTION_REJECTION_CODES.artistUploadsDisabled,
      message:
        'This artist profile cannot receive new recordings because of copyright strikes.',
      status: 403,
    };
  }

  const owner = artist.ownerOxyUserId;
  const claimant = artist.claimedByOxyUserId;

  // A — the uploader is the artist. Ordinary creator upload, no attestation:
  // nobody attests to their own authorship, they simply publish.
  if (owner === uploaderOxyUserId || claimant === uploaderOxyUserId) {
    return { allowed: true, mode: 'owner', artistId, requiresAttestation: false };
  }

  // B — somebody else holds this profile.
  if (owner || claimant) {
    if (artist.acceptsContributions !== true) {
      return {
        allowed: false,
        code: CONTRIBUTION_REJECTION_CODES.artistContributionsClosed,
        message:
          'This artist is on Syra and does not accept recordings uploaded by other ' +
          'people. You can still keep this file in your private library.',
        status: 403,
      };
    }
    return { allowed: true, mode: 'contribution', artistId, requiresAttestation: true };
  }

  // C — unclaimed, or a stub created from somebody's file tags.
  return { allowed: true, mode: 'contribution', artistId, requiresAttestation: true };
}
