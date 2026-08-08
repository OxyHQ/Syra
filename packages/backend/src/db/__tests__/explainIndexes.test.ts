import { describe, expect, it } from 'bun:test';
import { expectIndexesWithin } from './explainIndexes';

/**
 * The helper every EXPLAIN suite now asserts through, tested directly.
 *
 * These suites are slow, seed-dependent and shared, so a defect in the assertion
 * itself would be discovered as "the plans are fine" rather than as a failure.
 * The three cases below are the ones that decide whether it is worth anything:
 * it must reject an index nobody accepted, reject a plan with NO index at all,
 * and accept a legitimate choice among equals.
 */

function failureOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the assertion to fail, and it passed');
}

describe('expectIndexesWithin', () => {
  it('accepts any member of the accepted set, which is the point of a set', () => {
    for (const used of ['a_idx', 'b_idx', 'b_idx, a_idx']) {
      expectIndexesWithin('probe', used, ['a_idx', 'b_idx']);
    }
  });

  /**
   * The hole `toContain('<prefix>_')` left, and the reason this helper exists:
   * an acceptable index present ALONGSIDE an unacceptable one passed a prefix
   * check, because the prefix only asks whether a good name appears somewhere.
   */
  it('rejects an unaccepted index sitting beside an accepted one', () => {
    const message = failureOf(() =>
      expectIndexesWithin('probe', 'a_idx, tracks_seq_fallback_idx', ['a_idx']));
    expect(message).toContain('tracks_seq_fallback_idx');
  });

  /**
   * A subset check is satisfied by the empty set. `toContain` happened to reject
   * a plan with no index scan (an empty string contains no prefix), so that
   * rejection had to be restored deliberately rather than inherited — this is
   * the test that says so.
   */
  it('rejects a plan that used no index at all', () => {
    expect(failureOf(() => expectIndexesWithin('probe', '', ['a_idx'])))
      .toContain('NO index scan');
  });

  it('names both sides so a failure is actionable without opening the file', () => {
    const message = failureOf(() => expectIndexesWithin('myProbe', 'c_idx', ['a_idx', 'b_idx']));
    expect(message).toContain('myProbe');
    expect(message).toContain('c_idx');
    expect(message).toContain('a_idx, b_idx');
  });
});
