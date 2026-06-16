import { describe, it, expect } from 'bun:test';
import { playCountToPopularity } from './popularity';

describe('playCountToPopularity', () => {
  it('maps 0 / negative / non-finite to 0', () => {
    expect(playCountToPopularity(0)).toBe(0);
    expect(playCountToPopularity(-5)).toBe(0);
    expect(playCountToPopularity(Number.NaN)).toBe(0);
    expect(playCountToPopularity(undefined)).toBe(0);
  });

  it('is monotonically non-decreasing in play count', () => {
    const a = playCountToPopularity(10);
    const b = playCountToPopularity(1000);
    const c = playCountToPopularity(1_000_000);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('clamps to 100 at and beyond the saturation point', () => {
    expect(playCountToPopularity(10_000_000)).toBe(100);
    expect(playCountToPopularity(50_000_000)).toBe(100);
  });

  it('always returns an integer within [0, 100]', () => {
    for (const n of [1, 7, 99, 12345, 987654]) {
      const v = playCountToPopularity(n);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});
