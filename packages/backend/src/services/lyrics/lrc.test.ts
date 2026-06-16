import { describe, it, expect } from 'bun:test';
import { parseLrc } from './lrc';

describe('parseLrc — single-timestamp lines', () => {
  it('parses a single line with centisecond (.xx) timestamp', () => {
    const lines = parseLrc('[00:12.34] Hello world');
    expect(lines).toHaveLength(1);
    expect(lines[0].timeMs).toBe(12 * 1000 + 340); // 34 centiseconds = 340 ms
    expect(lines[0].text).toBe('Hello world');
  });

  it('parses a single line with millisecond (.xxx) timestamp', () => {
    const lines = parseLrc('[01:23.456] Another line');
    expect(lines).toHaveLength(1);
    expect(lines[0].timeMs).toBe(60 * 1000 + 23 * 1000 + 456);
    expect(lines[0].text).toBe('Another line');
  });

  it('parses minutes correctly', () => {
    const lines = parseLrc('[03:05.00] verse');
    expect(lines[0].timeMs).toBe(3 * 60 * 1000 + 5 * 1000);
  });

  it('tolerates missing fractional part', () => {
    const lines = parseLrc('[00:30] no fractions');
    expect(lines[0].timeMs).toBe(30 * 1000);
    expect(lines[0].text).toBe('no fractions');
  });

  it('keeps timed lines with empty text (instrumental gaps)', () => {
    const lines = parseLrc('[00:05.00]');
    expect(lines).toHaveLength(1);
    expect(lines[0].timeMs).toBe(5000);
    expect(lines[0].text).toBe('');
  });
});

describe('parseLrc — multi-timestamp lines', () => {
  it('emits one LyricsLine per timestamp for a multi-tag line', () => {
    const lines = parseLrc('[00:12.00][00:47.30] chorus');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.timeMs)).toContain(12000);
    expect(lines.map((l) => l.timeMs)).toContain(47300);
    expect(lines[0].text).toBe('chorus');
    expect(lines[1].text).toBe('chorus');
  });

  it('handles three timestamps on one line', () => {
    const lines = parseLrc('[00:10.00][00:20.00][00:30.00] repeat');
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.text)).toEqual(['repeat', 'repeat', 'repeat']);
  });
});

describe('parseLrc — metadata / ID tags skipped', () => {
  it('skips [ar:...] artist tag', () => {
    const lines = parseLrc('[ar:Some Artist]\n[00:01.00] first line');
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('first line');
  });

  it('skips [ti:...] title tag', () => {
    const lines = parseLrc('[ti:Track Title]\n[00:05.00] lyric');
    expect(lines).toHaveLength(1);
  });

  it('skips [length:...] and other common ID tags', () => {
    const lines = parseLrc('[length:3:45]\n[al:Album]\n[00:02.50] line');
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('line');
  });
});

describe('parseLrc — output sorted ascending', () => {
  it('sorts lines by timeMs ascending regardless of input order', () => {
    const input = '[00:30.00] third\n[00:10.00] first\n[00:20.00] second';
    const lines = parseLrc(input);
    expect(lines.map((l) => l.text)).toEqual(['first', 'second', 'third']);
  });
});

describe('parseLrc — edge cases', () => {
  it('returns [] for empty string', () => {
    expect(parseLrc('')).toEqual([]);
  });

  it('returns [] for garbage input (no valid timestamps)', () => {
    expect(parseLrc('no tags here\njust text\n!!!')).toEqual([]);
  });

  it('handles a full LRC block correctly', () => {
    const lrc = [
      '[ar:Test Artist]',
      '[ti:Test Track]',
      '[00:01.00] Line one',
      '[00:02.50] Line two',
      '[00:04.00][00:08.00] Repeated line',
    ].join('\n');

    const lines = parseLrc(lrc);
    expect(lines).toHaveLength(4);
    expect(lines[0].text).toBe('Line one');
    expect(lines[1].text).toBe('Line two');
    // Repeated line appears at 4s and 8s, sorted
    expect(lines[2].timeMs).toBe(4000);
    expect(lines[3].timeMs).toBe(8000);
  });
});
