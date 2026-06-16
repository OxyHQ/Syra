import { isRealFinish, FINISH_EPSILON_SEC } from './playback/isRealFinish';

describe('isRealFinish', () => {
  describe('spurious finish (false)', () => {
    it('returns false when duration is 0 — no metadata yet', () => {
      expect(isRealFinish(0, 0)).toBe(false);
    });

    it('returns false when position is at start of a real track', () => {
      expect(isRealFinish(180, 0.2)).toBe(false);
    });

    it('returns false when position is in the middle of a track', () => {
      expect(isRealFinish(180, 90)).toBe(false);
    });

    it('returns false when position is just outside epsilon of end', () => {
      // FINISH_EPSILON_SEC before the end + 0.1s extra = still spurious
      expect(isRealFinish(180, 180 - FINISH_EPSILON_SEC - 0.1)).toBe(false);
    });
  });

  describe('real finish (true)', () => {
    it('returns true when position is within epsilon of end', () => {
      expect(isRealFinish(180, 179)).toBe(true);
    });

    it('returns true at exact epsilon boundary', () => {
      expect(isRealFinish(180, 180 - FINISH_EPSILON_SEC)).toBe(true);
    });

    it('returns true when position equals duration (already at end)', () => {
      expect(isRealFinish(180, 180)).toBe(true);
    });

    it('returns true for a short track at its natural end', () => {
      expect(isRealFinish(30, 29)).toBe(true);
    });
  });
});
