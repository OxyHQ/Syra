import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { connectDb, clearDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { catalogEntities, tracks } from '../../db/schema/catalog';
import { contributorStandings, contributorStrikes } from '../../db/schema/creators';
import {
  recordContributorStrike,
  canContributePublicly,
  getContributorStanding,
} from './contributorStrikes';
import { STRIKE_TERMINATION_THRESHOLD } from '../strikeService';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const UPLOADER = 'oxy-contributor-1';

/**
 * A real track to hang a strike's audit pointer off.
 *
 * `contributor_strikes.track_id` is a real `ON DELETE set null` reference now,
 * so the invented `'track-1'` this fixture used is a `23503`. That is worth
 * having: the pointer exists so a reviewer can open the offending work, and a
 * strike naming a track that does not exist was never a state worth supporting.
 */
async function seedTrack(): Promise<string> {
  const db = getDb();
  const [artist] = await db
    .insert(catalogEntities)
    .values({ name: 'strike-fixture-artist', type: 'artist', source: 'upload' })
    .returning({ id: catalogEntities.id });
  const [track] = await db
    .insert(tracks)
    .values({
      title: 'strike-fixture-track',
      artistId: artist.id,
      artistName: 'strike-fixture-artist',
      duration: 100,
      source: 'upload',
    })
    .returning({ id: tracks.id });
  return track.id;
}

/**
 * The stored row, read back independently of the function under test.
 *
 * `getContributorStanding` is itself under test in this file, so the assertions
 * about what actually LANDED read the table directly — a helper that shared the
 * production read would pass whenever the two agreed, including when both are
 * wrong.
 */
async function storedStanding(oxyUserId: string) {
  const [standing] = await getDb()
    .select()
    .from(contributorStandings)
    .where(eq(contributorStandings.oxyUserId, oxyUserId));
  if (!standing) return undefined;
  const strikes = await getDb()
    .select()
    .from(contributorStrikes)
    .where(eq(contributorStrikes.contributorStandingId, standing.id));
  return { ...standing, strikes };
}

describe('recordContributorStrike', () => {
  it('opens a record on the first strike — nobody has one until they need it', async () => {
    expect(await getContributorStanding(UPLOADER)).toBeNull();

    const trackId = await seedTrack();
    const outcome = await recordContributorStrike(UPLOADER, 'first complaint', trackId);

    expect(outcome).toEqual({
      oxyUserId: UPLOADER, strikeCount: 1, terminated: false, alreadyTerminated: false,
    });
    const standing = await storedStanding(UPLOADER);
    expect(standing?.strikeCount).toBe(1);
    expect(standing?.strikes).toHaveLength(1);
    expect(standing?.strikes[0]?.reason).toBe('first complaint');
    expect(standing?.strikes[0]?.trackId).toBe(trackId);
    expect(standing?.lastStrikeAt).toBeInstanceOf(Date);
  });

  it('accumulates without terminating below the threshold', async () => {
    await recordContributorStrike(UPLOADER, 'one');
    const second = await recordContributorStrike(UPLOADER, 'two');

    expect(second.strikeCount).toBe(2);
    expect(second.terminated).toBe(false);
    const standing = await storedStanding(UPLOADER);
    expect(standing?.terminated).toBe(false);
    expect(standing?.uploadsDisabled).toBe(false);
  });

  /**
   * The threshold is imported from `strikeService`, not redeclared — the two
   * populations answer to ONE policy, and a second constant is how they drift to
   * different numbers without anybody deciding they should.
   */
  it('terminates at the same threshold artists face', async () => {
    for (let i = 1; i < STRIKE_TERMINATION_THRESHOLD; i += 1) {
      const partial = await recordContributorStrike(UPLOADER, `complaint ${i}`);
      expect(partial.terminated).toBe(false);
    }

    const final = await recordContributorStrike(UPLOADER, 'final complaint');

    expect(final.strikeCount).toBe(STRIKE_TERMINATION_THRESHOLD);
    expect(final.terminated).toBe(true);
    const standing = await storedStanding(UPLOADER);
    expect(standing?.terminated).toBe(true);
    expect(standing?.uploadsDisabled).toBe(true);
    expect(standing?.terminatedAt).toBeInstanceOf(Date);
    expect(standing?.terminationReason).toContain('Repeat-infringer');
  });

  /**
   * `terminated` is the TRANSITION, so the caller cascades exactly once. A fourth
   * strike against an account already terminated must not re-run a locker purge
   * that has already happened.
   */
  it('reports termination once, then reports it as already terminated', async () => {
    for (let i = 0; i < STRIKE_TERMINATION_THRESHOLD; i += 1) {
      await recordContributorStrike(UPLOADER, `complaint ${i}`);
    }

    const fourth = await recordContributorStrike(UPLOADER, 'one more');

    expect(fourth.strikeCount).toBe(STRIKE_TERMINATION_THRESHOLD + 1);
    expect(fourth.terminated).toBe(false);
    expect(fourth.alreadyTerminated).toBe(true);
    // Still terminated — a later strike never un-terminates.
    const standing = await storedStanding(UPLOADER);
    expect(standing?.terminated).toBe(true);
  });

  it('counts each account separately', async () => {
    await recordContributorStrike('user-a', 'theirs');
    await recordContributorStrike('user-b', 'theirs');
    await recordContributorStrike('user-b', 'theirs again');

    expect((await getContributorStanding('user-a'))?.strikeCount).toBe(1);
    expect((await getContributorStanding('user-b'))?.strikeCount).toBe(2);
  });
});

describe('canContributePublicly', () => {
  it('allows an account nobody has ever complained about', async () => {
    expect(await canContributePublicly('a-brand-new-user')).toBe(true);
  });

  it('still allows an account below the threshold', async () => {
    await recordContributorStrike(UPLOADER, 'one');
    expect(await canContributePublicly(UPLOADER)).toBe(true);
  });

  it('refuses a terminated account', async () => {
    for (let i = 0; i < STRIKE_TERMINATION_THRESHOLD; i += 1) {
      await recordContributorStrike(UPLOADER, `complaint ${i}`);
    }
    expect(await canContributePublicly(UPLOADER)).toBe(false);
  });

  it('refuses an account with uploads disabled but not terminated', async () => {
    await getDb()
      .insert(contributorStandings)
      .values({ oxyUserId: UPLOADER, uploadsDisabled: true });
    expect(await canContributePublicly(UPLOADER)).toBe(false);
  });
});
