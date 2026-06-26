import { describe, it, expect } from 'bun:test';
import { parseRange } from './podcastAudio.controller';

const TOTAL = 1000;

describe('parseRange', () => {
  it('parses a closed range bytes=a-b', () => {
    expect(parseRange('bytes=0-499', TOTAL)).toEqual({ start: 0, end: 499 });
    expect(parseRange('bytes=200-799', TOTAL)).toEqual({ start: 200, end: 799 });
  });

  it('parses an open-ended range bytes=a-', () => {
    expect(parseRange('bytes=500-', TOTAL)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=0-', TOTAL)).toEqual({ start: 0, end: 999 });
  });

  it('parses a suffix range bytes=-N (last N bytes)', () => {
    expect(parseRange('bytes=-100', TOTAL)).toEqual({ start: 900, end: 999 });
  });

  it('clamps a suffix larger than the total to the whole object', () => {
    expect(parseRange('bytes=-5000', TOTAL)).toEqual({ start: 0, end: 999 });
  });

  it('clamps an end past the last byte', () => {
    expect(parseRange('bytes=0-99999', TOTAL)).toEqual({ start: 0, end: 999 });
  });

  it('returns null for missing / empty / malformed headers', () => {
    expect(parseRange(undefined, TOTAL)).toBeNull();
    expect(parseRange('', TOTAL)).toBeNull();
    expect(parseRange('bytes=', TOTAL)).toBeNull();
    expect(parseRange('bytes=-', TOTAL)).toBeNull();
    expect(parseRange('bytes=abc', TOTAL)).toBeNull();
    expect(parseRange('items=0-1', TOTAL)).toBeNull();
  });

  it('returns null for unsatisfiable ranges', () => {
    expect(parseRange('bytes=1000-', TOTAL)).toBeNull(); // start >= total
    expect(parseRange('bytes=500-499', TOTAL)).toBeNull(); // start > end
  });
});
