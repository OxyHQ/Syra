import type { LyricsLine } from '@syra/shared-types';

/**
 * Pure LRC format parser.
 *
 * LRC is a plain-text format where each lyric line is prefixed with one or
 * more timestamps: `[mm:ss.xx] text` (centiseconds) or `[mm:ss.xxx] text`
 * (milliseconds). A single line may repeat the same text at multiple offsets
 * by stacking timestamps: `[00:12.00][00:47.30] chorus`.
 *
 * Metadata / ID tags (`[ar:...]`, `[ti:...]`, `[al:...]`, `[length:...]`,
 * etc.) are not time tags and are silently skipped.
 */

/** Matches a single time tag: [mm:ss], [mm:ss.xx], or [mm:ss.xxx]. */
const TIME_TAG_RE = /\[(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?\]/g;

/**
 * Returns true when the bracket content is a time tag (`mm:ss` form).
 * ID tags have letter-prefixed content (`ar:`, `ti:`, etc.) or no colon at
 * a digit boundary.
 */
function isTimeTag(content: string): boolean {
  return /^\d{1,2}:\d{2}(?:\.\d{2,3})?$/.test(content);
}

/**
 * Parse a fractional seconds string (centiseconds `.xx` or milliseconds
 * `.xxx`) into milliseconds.
 *
 * LRC uses centiseconds (2 digits): `.34` → 340 ms.
 * Some tools emit milliseconds (3 digits): `.456` → 456 ms.
 */
function parseFraction(frac: string | undefined): number {
  if (!frac) return 0;
  if (frac.length === 2) return parseInt(frac, 10) * 10; // centiseconds → ms
  return parseInt(frac, 10);                              // milliseconds
}

/**
 * Parse an LRC string and return timed lyric lines sorted by timeMs ascending.
 *
 * - Multi-timestamp lines emit one LyricsLine per timestamp (same text).
 * - Timed lines with empty text are kept (instrumental gaps).
 * - ID/metadata tags and non-LRC lines are silently ignored.
 */
export function parseLrc(lrc: string): LyricsLine[] {
  if (!lrc.trim()) return [];

  const result: LyricsLine[] = [];

  for (const rawLine of lrc.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // Collect all time tags at the start of the line
    const timestamps: number[] = [];
    let lastTagEnd = 0;

    // Reset regex state before each line
    TIME_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    // Scan from the beginning; collect consecutive time tags
    while ((match = TIME_TAG_RE.exec(line)) !== null) {
      // Only accept time tags that appear before any non-tag text starts.
      // Tags may be separated only by other tags, not by free text.
      if (match.index !== lastTagEnd) break;

      const bracketContent = line.slice(match.index + 1, match.index + match[0].length - 1);
      if (!isTimeTag(bracketContent)) {
        // It's an ID tag or unknown bracket — skip the whole line
        break;
      }

      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const ms = parseFraction(match[3]);
      timestamps.push(minutes * 60_000 + seconds * 1_000 + ms);
      lastTagEnd = match.index + match[0].length;
    }

    if (timestamps.length === 0) continue;

    // Text is everything after the last time tag
    const text = line.slice(lastTagEnd).trim();

    for (const timeMs of timestamps) {
      result.push({ timeMs, text });
    }
  }

  return result.sort((a, b) => a.timeMs - b.timeMs);
}
