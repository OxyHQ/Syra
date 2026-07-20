import { describe, it, expect } from 'bun:test';
import { MAX_PAGE_SIZE, parseBoundedLimit, parseClampedLimit, parseOffset } from './reqParams';

/**
 * These two helpers have the same shape and DIFFERENT published contracts, which
 * is how a shared implementation previously changed `?limit=0` on a
 * clamped search endpoint from 1 to 20. The boundary cases below are the contracts —
 * if one of these assertions disagrees with the implementation, the
 * implementation is what changed.
 */
describe('parseBoundedLimit — unusable input means default', () => {
  it('returns the fallback for absent, non-numeric, zero and negative input', () => {
    expect(parseBoundedLimit(undefined, 20)).toBe(20);
    expect(parseBoundedLimit('abc', 20)).toBe(20);
    expect(parseBoundedLimit('0', 20)).toBe(20);
    expect(parseBoundedLimit('-5', 20)).toBe(20);
  });

  it('passes a positive value through and caps it at max', () => {
    expect(parseBoundedLimit('7', 20, 50)).toBe(7);
    expect(parseBoundedLimit('999', 20, 50)).toBe(50);
  });

  it('defaults its ceiling to MAX_PAGE_SIZE so no route is unbounded', () => {
    expect(parseBoundedLimit('100000', 20)).toBe(MAX_PAGE_SIZE);
  });
});

describe('parseClampedLimit — out-of-range clamps to nearest valid value', () => {
  const range = { min: 1, max: 50, fallback: 20 };

  it('clamps below-range up to min rather than falling back', () => {
    expect(parseClampedLimit('0', range)).toBe(1);
    expect(parseClampedLimit('-5', range)).toBe(1);
  });

  it('clamps above-range down to max', () => {
    expect(parseClampedLimit('999', range)).toBe(50);
  });

  it('falls back only when the input is not a number at all', () => {
    expect(parseClampedLimit(undefined, range)).toBe(20);
    expect(parseClampedLimit('abc', range)).toBe(20);
  });

  it('passes an in-range value through', () => {
    expect(parseClampedLimit('7', range)).toBe(7);
  });
});

describe('parseOffset', () => {
  it('clamps negatives and non-numbers to 0 so .skip() cannot throw', () => {
    expect(parseOffset('-5')).toBe(0);
    expect(parseOffset('abc')).toBe(0);
    expect(parseOffset(undefined)).toBe(0);
    expect(parseOffset('0')).toBe(0);
  });

  it('passes a positive offset through, uncapped for deep paging', () => {
    expect(parseOffset('25')).toBe(25);
    expect(parseOffset('100000')).toBe(100000);
  });
});
