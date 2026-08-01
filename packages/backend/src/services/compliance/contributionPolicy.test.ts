import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { ArtistModel } from '../../models/CatalogEntity';
import {
  evaluatePublicContribution,
  CONTRIBUTION_REJECTION_CODES,
} from './contributionPolicy';
import { recordContributorStrike } from './contributorStrikes';
import { STRIKE_TERMINATION_THRESHOLD } from '../strikeService';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const UPLOADER = 'oxy-uploader';
const SOMEONE_ELSE = 'oxy-other';

async function makeArtist(overrides: Record<string, unknown> = {}): Promise<string> {
  const artist = await ArtistModel.create({
    name: `Artist ${Math.random().toString(36).slice(2)}`,
    source: 'upload',
    ...overrides,
  });
  return artist._id.toString();
}

describe('evaluatePublicContribution — no artist resolved', () => {
  it('REJECTS with the artist_unresolved code rather than degrading to the locker', async () => {
    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected a rejection');
    expect(decision.code).toBe(CONTRIBUTION_REJECTION_CODES.artistUnresolved);
    expect(decision.status).toBe(422);
    // The human half of the contract: the uploader has to learn what is missing.
    expect(decision.message.length).toBeGreaterThan(0);
    expect(decision.message).toContain('artist');
  });

  it('REJECTS an artist id that resolves to nothing', async () => {
    const decision = await evaluatePublicContribution({
      uploaderOxyUserId: UPLOADER,
      artistId: '507f1f77bcf86cd799439011',
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected a rejection');
    expect(decision.code).toBe(CONTRIBUTION_REJECTION_CODES.artistNotFound);
  });
});

describe('evaluatePublicContribution — A: the uploader owns the artist', () => {
  it('allows the ordinary creator path, with no attestation', async () => {
    const artistId = await makeArtist({ ownerOxyUserId: UPLOADER });

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER, artistId });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('expected an allow');
    expect(decision.mode).toBe('owner');
    expect(decision.requiresAttestation).toBe(false);
  });

  it('treats a claimant as the owner', async () => {
    const artistId = await makeArtist({ claimedByOxyUserId: UPLOADER });

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER, artistId });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('expected an allow');
    expect(decision.mode).toBe('owner');
  });
});

describe('evaluatePublicContribution — B: somebody else holds the artist', () => {
  it('BLOCKS when acceptsContributions is false', async () => {
    const artistId = await makeArtist({
      ownerOxyUserId: SOMEONE_ELSE,
      acceptsContributions: false,
    });

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER, artistId });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected a rejection');
    expect(decision.code).toBe(CONTRIBUTION_REJECTION_CODES.artistContributionsClosed);
    expect(decision.status).toBe(403);
  });

  it('BLOCKS when acceptsContributions was never set — the default is closed', async () => {
    const artistId = await makeArtist({ ownerOxyUserId: SOMEONE_ELSE });

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER, artistId });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected a rejection');
    expect(decision.code).toBe(CONTRIBUTION_REJECTION_CODES.artistContributionsClosed);
  });

  it('ALLOWS as a contribution once the artist opens it', async () => {
    const artistId = await makeArtist({
      ownerOxyUserId: SOMEONE_ELSE,
      acceptsContributions: true,
    });

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER, artistId });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('expected an allow');
    expect(decision.mode).toBe('contribution');
    expect(decision.requiresAttestation).toBe(true);
  });

  it('BLOCKS a claimed-by-someone-else artist that is closed', async () => {
    const artistId = await makeArtist({ claimedByOxyUserId: SOMEONE_ELSE });

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER, artistId });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected a rejection');
    expect(decision.code).toBe(CONTRIBUTION_REJECTION_CODES.artistContributionsClosed);
  });
});

describe('evaluatePublicContribution — C: unclaimed artist', () => {
  it('ALLOWS a contribution to a claimable stub', async () => {
    const artistId = await makeArtist({ claimable: true, origin: 'contributed' });

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER, artistId });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('expected an allow');
    expect(decision.mode).toBe('contribution');
    expect(decision.requiresAttestation).toBe(true);
  });
});

describe('evaluatePublicContribution — strike state gates every path', () => {
  it('BLOCKS the owner of a strike-disabled profile', async () => {
    const artistId = await makeArtist({ ownerOxyUserId: UPLOADER, uploadsDisabled: true });

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER, artistId });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected a rejection');
    expect(decision.code).toBe(CONTRIBUTION_REJECTION_CODES.artistUploadsDisabled);
  });

  it('BLOCKS a contribution to a TERMINATED stub, however open it says it is', async () => {
    const artistId = await makeArtist({
      claimable: true,
      acceptsContributions: true,
      terminated: true,
    });

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER, artistId });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected a rejection');
    expect(decision.code).toBe(CONTRIBUTION_REJECTION_CODES.artistUploadsDisabled);
  });
});

// ── The uploader's own standing ───────────────────────────────────────────────

/**
 * The gate that reaches the population with no artist profile. It is checked
 * BEFORE anything about the destination, so a repeat infringer is refused
 * wherever they aim — including at a profile they own and at an artist who has
 * opened their page to contributions.
 */
describe('evaluatePublicContribution — a blocked contributor is blocked everywhere', () => {
  async function terminate(oxyUserId: string): Promise<void> {
    for (let i = 0; i < STRIKE_TERMINATION_THRESHOLD; i += 1) {
      await recordContributorStrike(oxyUserId, `complaint ${i}`);
    }
  }

  it('BLOCKS a terminated account contributing to an unclaimed artist', async () => {
    await terminate(UPLOADER);
    const artistId = await makeArtist({ claimable: true });

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER, artistId });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected a rejection');
    expect(decision.code).toBe(CONTRIBUTION_REJECTION_CODES.contributorBlocked);
    expect(decision.status).toBe(403);
  });

  it('BLOCKS them at an artist who WELCOMES contributions', async () => {
    await terminate(UPLOADER);
    const artistId = await makeArtist({
      ownerOxyUserId: SOMEONE_ELSE,
      acceptsContributions: true,
    });

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER, artistId });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected a rejection');
    expect(decision.code).toBe(CONTRIBUTION_REJECTION_CODES.contributorBlocked);
  });

  it('BLOCKS them at their OWN artist profile', async () => {
    await terminate(UPLOADER);
    const artistId = await makeArtist({ ownerOxyUserId: UPLOADER });

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER, artistId });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected a rejection');
    expect(decision.code).toBe(CONTRIBUTION_REJECTION_CODES.contributorBlocked);
  });

  it('BLOCKS them before the missing-artist check, so the reason names THEM', async () => {
    await terminate(UPLOADER);

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected a rejection');
    expect(decision.code).toBe(CONTRIBUTION_REJECTION_CODES.contributorBlocked);
  });

  it('still allows an account below the threshold', async () => {
    await recordContributorStrike(UPLOADER, 'one complaint');
    const artistId = await makeArtist({ claimable: true });

    const decision = await evaluatePublicContribution({ uploaderOxyUserId: UPLOADER, artistId });

    expect(decision.allowed).toBe(true);
  });
});
