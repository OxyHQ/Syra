/**
 * Podcast discovery — resolves a free-text query to feed candidates via the
 * Podcast Index API (primary; Podcasting 2.0 tags) plus the Apple iTunes Search
 * API (no key; resolves `feedUrl`, artwork, genres, broad coverage).
 *
 * These are FIXED, trusted provider hosts (not caller-supplied URLs), so a plain
 * `fetch` is correct here — `safeFetch`'s SSRF guard is for the user-influenced
 * RSS feed URL handled by `RssConnector`. Both providers degrade gracefully: a
 * missing key or a network error yields `[]`, never a throw, so discovery still
 * works on whichever provider is available.
 *
 * The canonical content always comes from the feed itself (mirrored by
 * `podcastImportService`); the directory only points us at `feedUrl`.
 */

import crypto from 'node:crypto';
import { logger } from '../../utils/logger';

const PODCAST_INDEX_BASE = 'https://api.podcastindex.org/api/1.0';
const APPLE_SEARCH_BASE = 'https://itunes.apple.com/search';
const USER_AGENT = 'Syra/1.0 (+https://syra.fm)';

export interface PodcastDirectoryCandidate {
  feedUrl: string;
  title: string;
  author?: string;
  image?: string;
  categories: string[];
  podcastGuid?: string;
  podcastIndexId?: number;
  appleCollectionId?: number;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

// ── Podcast Index ────────────────────────────────────────────────────────────

/**
 * Podcast Index auth: `Authorization = sha1(key + secret + unixSeconds)` (hex),
 * sent alongside `X-Auth-Key` and `X-Auth-Date`. Returns null when credentials
 * are not configured.
 */
function podcastIndexHeaders(): Record<string, string> | null {
  const key = process.env.PODCAST_INDEX_KEY?.trim();
  const secret = process.env.PODCAST_INDEX_SECRET?.trim();
  if (!key || !secret) return null;

  const authDate = Math.floor(Date.now() / 1000).toString();
  const authorization = crypto.createHash('sha1').update(key + secret + authDate).digest('hex');

  return {
    'User-Agent': USER_AGENT,
    'X-Auth-Key': key,
    'X-Auth-Date': authDate,
    Authorization: authorization,
  };
}

async function searchPodcastIndex(query: string, limit: number): Promise<PodcastDirectoryCandidate[]> {
  const headers = podcastIndexHeaders();
  if (!headers) return [];

  try {
    const url = `${PODCAST_INDEX_BASE}/search/byterm?q=${encodeURIComponent(query)}&max=${limit}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      logger.debug('[podcasts] Podcast Index search non-OK', { status: response.status });
      return [];
    }

    const body = asRecord(await response.json());
    const feeds = Array.isArray(body?.['feeds']) ? body['feeds'] : [];
    const candidates: PodcastDirectoryCandidate[] = [];

    for (const raw of feeds) {
      const feed = asRecord(raw);
      const feedUrl = cleanString(feed?.['url']);
      const title = cleanString(feed?.['title']);
      if (!feedUrl || !title) continue;

      const categoriesRecord = asRecord(feed?.['categories']);
      const categories = categoriesRecord
        ? Object.values(categoriesRecord).map(cleanString).filter((c): c is string => c !== undefined)
        : [];

      candidates.push({
        feedUrl,
        title,
        author: cleanString(feed?.['author']),
        image: cleanString(feed?.['image']) ?? cleanString(feed?.['artwork']),
        categories,
        podcastGuid: cleanString(feed?.['podcastGuid']),
        podcastIndexId: cleanNumber(feed?.['id']),
        appleCollectionId: cleanNumber(feed?.['itunesId']),
      });
    }

    return candidates;
  } catch (err) {
    logger.debug('[podcasts] Podcast Index search failed', { err });
    return [];
  }
}

// ── Apple iTunes Search ──────────────────────────────────────────────────────

async function searchApple(query: string, limit: number): Promise<PodcastDirectoryCandidate[]> {
  try {
    const url = `${APPLE_SEARCH_BASE}?media=podcast&term=${encodeURIComponent(query)}&limit=${limit}`;
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) {
      logger.debug('[podcasts] Apple search non-OK', { status: response.status });
      return [];
    }

    const body = asRecord(await response.json());
    const results = Array.isArray(body?.['results']) ? body['results'] : [];
    const candidates: PodcastDirectoryCandidate[] = [];

    for (const raw of results) {
      const result = asRecord(raw);
      const feedUrl = cleanString(result?.['feedUrl']);
      const title = cleanString(result?.['collectionName']) ?? cleanString(result?.['trackName']);
      if (!feedUrl || !title) continue;

      const genres = Array.isArray(result?.['genres'])
        ? result['genres'].map(cleanString).filter((g): g is string => g !== undefined)
        : [];

      candidates.push({
        feedUrl,
        title,
        author: cleanString(result?.['artistName']),
        image: cleanString(result?.['artworkUrl600']) ?? cleanString(result?.['artworkUrl100']),
        categories: genres,
        appleCollectionId: cleanNumber(result?.['collectionId']),
      });
    }

    return candidates;
  } catch (err) {
    logger.debug('[podcasts] Apple search failed', { err });
    return [];
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

const SEARCH_LIMIT_DEFAULT = 20;

/**
 * Search both directories and return de-duplicated candidates. Podcast Index
 * entries win on collision (richer Podcasting 2.0 metadata); Apple fills feeds
 * the index doesn't cover. Dedup key is the normalised `feedUrl`, then
 * `podcastGuid`.
 */
export async function searchPodcasts(
  query: string,
  limit: number = SEARCH_LIMIT_DEFAULT,
): Promise<PodcastDirectoryCandidate[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const [indexResults, appleResults] = await Promise.all([
    searchPodcastIndex(trimmed, limit),
    searchApple(trimmed, limit),
  ]);

  const byFeedUrl = new Map<string, PodcastDirectoryCandidate>();
  const seenGuids = new Set<string>();

  // Podcast Index first so its entries are authoritative on collision.
  for (const candidate of [...indexResults, ...appleResults]) {
    const feedKey = candidate.feedUrl.toLowerCase();
    if (byFeedUrl.has(feedKey)) continue;
    if (candidate.podcastGuid && seenGuids.has(candidate.podcastGuid)) continue;

    byFeedUrl.set(feedKey, candidate);
    if (candidate.podcastGuid) seenGuids.add(candidate.podcastGuid);
  }

  return Array.from(byFeedUrl.values()).slice(0, limit);
}
