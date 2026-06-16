import { describe, it, expect } from '@jest/globals';
import type { LyricsLine } from '@syra/shared-types';
import { activeLyricLineIndex } from './lyrics';

const lines: LyricsLine[] = [
  { timeMs: 0, text: 'a' },
  { timeMs: 1000, text: 'b' },
  { timeMs: 2000, text: 'c' },
];

describe('activeLyricLineIndex', () => {
  it('returns 0 when position is exactly the first line', () => {
    expect(activeLyricLineIndex(lines, 0)).toBe(0);
  });

  it('returns 0 when position is between first and second line', () => {
    expect(activeLyricLineIndex(lines, 500)).toBe(0);
  });

  it('returns 1 when position is exactly the second line', () => {
    expect(activeLyricLineIndex(lines, 1000)).toBe(1);
  });

  it('returns 1 when position is just before the third line', () => {
    expect(activeLyricLineIndex(lines, 1999)).toBe(1);
  });

  it('returns last index when position is past the final line', () => {
    expect(activeLyricLineIndex(lines, 5000)).toBe(2);
  });

  it('returns -1 when position is negative (before first line)', () => {
    expect(activeLyricLineIndex(lines, -1)).toBe(-1);
  });

  it('returns -1 for empty lines array', () => {
    expect(activeLyricLineIndex([], 1000)).toBe(-1);
  });
});
