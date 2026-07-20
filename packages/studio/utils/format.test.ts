import { describe, expect, it } from '@jest/globals';
import { formatDate, formatDuration } from './format';

describe('formatDuration', () => {
  it('renders an em dash for durations that carry no information', () => {
    // A track with no known length must not render as "0:00", which reads as a
    // real zero-length track rather than as missing data.
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
  });

  it('renders sub-hour durations as M:SS with a zero-padded seconds field', () => {
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(60)).toBe('1:00');
    expect(formatDuration(125)).toBe('2:05');
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('switches to H:MM:SS at exactly one hour and pads both lower fields', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(7325)).toBe('2:02:05');
  });

  it('truncates fractional seconds rather than rounding up', () => {
    // 89.9s is still 1:29 — rounding would show a duration the track never reaches.
    expect(formatDuration(89.9)).toBe('1:29');
  });
});

describe('formatDate', () => {
  it('renders an empty string for missing or unparseable input', () => {
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDate('not-a-date')).toBe('');
  });

  it('renders a parseable ISO date', () => {
    // Asserting the exact string would pin the test to the runner's locale, so
    // this checks only that a valid date produces output and an invalid one does not.
    expect(formatDate('2026-06-26T00:00:00.000Z')).not.toBe('');
  });
});
