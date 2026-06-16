/**
 * Lyrics types for Syra.
 *
 * Lyrics may be synced (timed LRC format) or plain text. The server always
 * prefers synced lyrics when available; plain text is a fallback.
 */

/** A single timed lyric line (from LRC format). */
export interface LyricsLine {
  /** Offset from the start of the track in milliseconds. */
  timeMs: number;
  /** Lyric text for this line (may be empty for instrumental gaps). */
  text: string;
}

/** Lyrics for a single track. */
export interface Lyrics {
  trackId: string;
  /** True when timed lines are present (LRC synced lyrics). */
  synced: boolean;
  /**
   * Synced: timed lines sorted by timeMs ascending.
   * Plain: one line per entry with timeMs === 0.
   */
  lines: LyricsLine[];
  /** Raw plain-text lyrics when available (may accompany synced lines). */
  plain?: string;
  /** Which provider supplied these lyrics (e.g. 'lrclib'). */
  source: string;
  /** ISO 8601 timestamp of the last fetch from the provider. */
  updatedAt?: string;
}

/** Query parameters for a lyrics lookup. */
export interface LyricsQuery {
  trackName: string;
  artistName: string;
  albumName?: string;
  /** Track duration in seconds — helps disambiguate same-titled tracks. */
  durationSec?: number;
}
