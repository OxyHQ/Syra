import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { ContributorStandingModel } from '../../models/ContributorStanding';
import {
  recordContributorStrike,
  canContributePublicly,
  getContributorStanding,
} from './contributorStrikes';
import { STRIKE_TERMINATION_THRESHOLD } from '../strikeService';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const UPLOADER = 'oxy-contributor-1';

describe('recordContributorStrike', () => {
  it('opens a record on the first strike — nobody has one until they need it', async () => {
    expect(await getContributorStanding(UPLOADER)).toBeNull();

    const outcome = await recordContributorStrike(UPLOADER, 'first complaint', 'track-1');

    expect(outcome).toEqual({
      oxyUserId: UPLOADER, strikeCount: 1, terminated: false, alreadyTerminated: false,
    });
    const standing = await ContributorStandingModel.findOne({ oxyUserId: UPLOADER }).lean();
    expect(standing?.strikeCount).toBe(1);
    expect(standing?.strikes).toHaveLength(1);
    expect(standing?.strikes[0]?.reason).toBe('first complaint');
    expect(standing?.strikes[0]?.trackId).toBe('track-1');
    expect(standing?.lastStrikeAt).toBeInstanceOf(Date);
  });

  it('accumulates without terminating below the threshold', async () => {
    await recordContributorStrike(UPLOADER, 'one');
    const second = await recordContributorStrike(UPLOADER, 'two');

    expect(second.strikeCount).toBe(2);
    expect(second.terminated).toBe(false);
    const standing = await ContributorStandingModel.findOne({ oxyUserId: UPLOADER }).lean();
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
    const standing = await ContributorStandingModel.findOne({ oxyUserId: UPLOADER }).lean();
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
    const standing = await ContributorStandingModel.findOne({ oxyUserId: UPLOADER }).lean();
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
    await ContributorStandingModel.create({ oxyUserId: UPLOADER, uploadsDisabled: true });
    expect(await canContributePublicly(UPLOADER)).toBe(false);
  });
});
