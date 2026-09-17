import type { Lyrics, LyricsQuery } from '@syra/shared-types';
import type { LyricsProvider } from './LyricsProvider';
import { parseLrc } from './lrc';

export const LRCLIB_DEFAULT_API_BASE = 'https://lrclib.net';
const LRCLIB_REQUEST_TIMEOUT_MS = 10_000;

// ── Fetch abstraction ─────────────────────────────────────────────────────────

/** Result shape returned by the injected fetchJson function. */
export interface FetchResult {
  status: number;
  body: unknown;
}

export type FetchJson = (url: string) => Promise<FetchResult>;

async function defaultFetchJson(url: string): Promise<FetchResult> {
  const r = await fetch(url, { signal: AbortSignal.timeout(LRCLIB_REQUEST_TIMEOUT_MS) });
  const body = r.ok && r.status !== 204 ? await r.json() : null;
  return { status: r.status, body };
}

// ── LRCLIB response shape ─────────────────────────────────────────────────────

interface LrclibBody {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
}

function isLrclibBody(value: unknown): value is LrclibBody {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const synced = v['syncedLyrics'];
  const plain = v['plainLyrics'];
  return (
    ('syncedLyrics' in v || 'plainLyrics' in v) &&
    (synced === undefined || synced === null || typeof synced === 'string') &&
    (plain === undefined || plain === null || typeof plain === 'string')
  );
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface LrclibProviderDeps {
  fetchJson?: FetchJson;
  apiBase?: string;
}

/**
 * Lyrics provider backed by LRCLIB (https://lrclib.net).
 *
 * LRCLIB is a free, open-source lyrics database. It returns both synced (LRC)
 * and plain-text lyrics. The provider prefers synced lyrics; plain text is used
 * as a fallback. A 404 response means no lyrics exist for the track — that is
 * not an error.
 *
 * The `fetchJson` dep is injected so tests can control both the HTTP status and
 * the response body without making real network calls.
 */
export class LrclibProvider implements LyricsProvider {
  readonly source = 'lrclib';

  private readonly fetchJson: FetchJson;
  private readonly apiBase: string;

  constructor(deps: LrclibProviderDeps = {}) {
    this.fetchJson = deps.fetchJson ?? defaultFetchJson;
    this.apiBase = deps.apiBase ?? process.env.LRCLIB_API_URL ?? LRCLIB_DEFAULT_API_BASE;
  }

  async getLyrics(query: LyricsQuery): Promise<Omit<Lyrics, 'trackId' | 'updatedAt'> | null> {
    const enc = encodeURIComponent;

    let url =
      `${this.apiBase}/api/get` +
      `?artist_name=${enc(query.artistName)}` +
      `&track_name=${enc(query.trackName)}`;

    if (query.albumName) url += `&album_name=${enc(query.albumName)}`;
    if (query.durationSec !== undefined) url += `&duration=${Math.round(query.durationSec)}`;

    const { status, body } = await this.fetchJson(url);

    if (status === 404 || status === 204) return null;
    if (status < 200 || status >= 300) {
      throw new Error(`lrclib request failed with status ${status}`);
    }

    if (!isLrclibBody(body)) throw new Error('Invalid lrclib response');

    const synced = body.syncedLyrics;
    const plain = body.plainLyrics;

    // Prefer valid timed lyrics; malformed timestamps must not hide plain lyrics.
    const lines = synced?.trim() ? parseLrc(synced) : [];
    if (lines.some((line) => line.text.trim())) {
      return {
        synced: true,
        lines,
        plain: plain ?? undefined,
        source: 'lrclib',
      };
    }

    // Fall back to plain text
    if (plain && plain.trim()) {
      return {
        synced: false,
        lines: plain.split('\n').map((text) => ({ timeMs: 0, text })),
        plain,
        source: 'lrclib',
      };
    }

    if (synced?.trim()) throw new Error('Invalid lrclib timed lyrics');
    return null;
  }
}
