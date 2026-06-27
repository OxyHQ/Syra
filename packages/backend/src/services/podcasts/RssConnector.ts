/**
 * RSS feed connector — fetches a podcast feed over an SSRF-safe channel and
 * normalises it to Syra's model shape.
 *
 * Security: the feed URL is caller/discovery-influenced, so every fetch goes
 * through `safeFetch` from `@oxyhq/core/server` (DNS-pinned, private/metadata-IP
 * denylist, bounded redirects). `safeFetch` already implements the Bun
 * `{ all: true }` DNS lookup-array contract internally, so the documented Bun
 * `results.sort is not a function` gotcha does not apply here.
 *
 * The RSS body is NEVER read at request time by clients — it is mirrored into
 * Mongo by `podcastImportService`, mirroring how `AudiusConnector` feeds the
 * catalog upsert path. Conditional GET (`ETag` / `Last-Modified`) makes repeat
 * crawls cheap (a `304` short-circuits to a no-op).
 */

import { XMLParser } from 'fast-xml-parser';
import type { IncomingMessage } from 'node:http';
import { safeFetch, SsrfRejection, UpstreamError } from '@oxyhq/core/server';
import type { SafeFetchOptions, SafeFetchResult } from '@oxyhq/core/server';
import { logger } from '../../utils/logger';

/** Injectable `safeFetch` shape — lets tests drive `fetchAndParse` offline. */
export type SafeFetchFn = (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResult>;

/** Hard cap on a feed body — protects memory against hostile/huge feeds. */
export const MAX_FEED_BYTES = 15 * 1024 * 1024; // 15 MB
/** Hard cap on episodes mirrored per feed in a single import. */
export const MAX_EPISODES_PER_FEED = 2000;

/** Tags that may legitimately repeat and must always be parsed as arrays. */
const ARRAY_TAGS = new Set<string>([
  'item',
  'itunes:category',
  'podcast:funding',
  'podcast:transcript',
  'podcast:person',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: false,
  isArray: (name: string) => ARRAY_TAGS.has(name),
});

// ── Normalised output ──────────────────────────────────────────────────────────

export interface ParsedFunding {
  url: string;
  message?: string;
}

export interface ParsedShow {
  title: string;
  description?: string;
  author?: string;
  image?: string;
  language?: string;
  categories: string[];
  explicit: boolean;
  link?: string;
  type: 'episodic' | 'serial';
  podcastGuid?: string;
  funding: ParsedFunding[];
  /** Channel-level `<podcast:person>` credits (show Hosts & Guests). */
  persons: ParsedPerson[];
}

export interface ParsedTranscript {
  url: string;
  type: string;
  language?: string;
}

export interface ParsedPerson {
  name: string;
  role?: string;
  group?: string;
  img?: string;
  href?: string;
}

export interface ParsedEpisode {
  guid: string;
  title: string;
  description?: string;
  summary?: string;
  enclosureUrl?: string;
  enclosureType?: string;
  enclosureLength?: number;
  duration: number;
  pubDate?: Date;
  season?: number;
  episodeNumber?: number;
  episodeType: 'full' | 'trailer' | 'bonus';
  image?: string;
  explicit: boolean;
  chapters?: { url: string; type: string };
  transcripts: ParsedTranscript[];
  persons: ParsedPerson[];
}

export interface RssFetchResult {
  /** True when the upstream returned 304 Not Modified — caller should no-op. */
  notModified: boolean;
  etag?: string;
  lastModified?: string;
  show?: ParsedShow;
  episodes?: ParsedEpisode[];
}

// ── Low-level value helpers ─────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Read the text content of a node (string, number, or `{ '#text': ... }`). */
function text(node: unknown): string | undefined {
  if (typeof node === 'string') {
    const trimmed = node.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof node === 'number') return String(node);
  const record = asRecord(node);
  if (record && '#text' in record) return text(record['#text']);
  return undefined;
}

/** Read an attribute value off a node. */
function attr(node: unknown, name: string): string | undefined {
  const record = asRecord(node);
  if (!record) return undefined;
  const value = record[`@_${name}`];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number') return String(value);
  return undefined;
}

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  const lowered = value.toLowerCase();
  return lowered === 'true' || lowered === 'yes' || lowered === '1';
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse an iTunes duration: plain seconds ("3600") or "HH:MM:SS" / "MM:SS". */
function parseDuration(value: string | undefined): number {
  if (!value) return 0;
  if (!value.includes(':')) {
    const seconds = parseInt(value, 10);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  }
  const parts = value.split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => !Number.isFinite(p))) return 0;
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseEpisodeType(value: string | undefined): 'full' | 'trailer' | 'bonus' {
  const lowered = value?.toLowerCase();
  if (lowered === 'trailer' || lowered === 'bonus') return lowered;
  return 'full';
}

// ── Normalisers ─────────────────────────────────────────────────────────────────

/** Collect the (possibly nested) `itunes:category` text + attr values. */
function collectCategories(raw: unknown): string[] {
  const categories: string[] = [];
  for (const node of asArray(raw)) {
    const value = attr(node, 'text') ?? text(node);
    if (value) categories.push(value);
    const nested = asRecord(node)?.['itunes:category'];
    if (nested !== undefined) {
      for (const child of asArray(nested)) {
        const childValue = attr(child, 'text') ?? text(child);
        if (childValue) categories.push(childValue);
      }
    }
  }
  return Array.from(new Set(categories));
}

/** Parse `<podcast:person>` nodes (channel- or item-level) into ParsedPerson[]. */
function collectPersons(raw: unknown): ParsedPerson[] {
  const persons: ParsedPerson[] = [];
  for (const node of asArray(raw)) {
    const name = text(node);
    if (name) {
      persons.push({
        name,
        role: attr(node, 'role'),
        group: attr(node, 'group'),
        img: attr(node, 'img'),
        href: attr(node, 'href'),
      });
    }
  }
  return persons;
}

function normaliseShow(channel: Record<string, unknown>): ParsedShow {
  const funding: ParsedFunding[] = [];
  for (const node of asArray(channel['podcast:funding'])) {
    const url = attr(node, 'url');
    if (url) funding.push({ url, message: text(node) });
  }

  const typeValue = (attr(channel['itunes:type'], 'text') ?? text(channel['itunes:type']))?.toLowerCase();

  return {
    title: text(channel['title']) ?? 'Untitled podcast',
    description: text(channel['description']) ?? text(channel['itunes:summary']),
    author: text(channel['itunes:author']) ?? text(channel['managingEditor']),
    image: attr(channel['itunes:image'], 'href') ?? text(asRecord(channel['image'])?.['url']),
    language: text(channel['language']),
    categories: collectCategories(channel['itunes:category']),
    explicit: parseBool(text(channel['itunes:explicit'])),
    link: text(channel['link']),
    type: typeValue === 'serial' ? 'serial' : 'episodic',
    podcastGuid: text(channel['podcast:guid']),
    funding,
    persons: collectPersons(channel['podcast:person']),
  };
}

function normaliseEpisode(item: Record<string, unknown>): ParsedEpisode | null {
  const enclosure = item['enclosure'];
  const enclosureUrl = attr(enclosure, 'url');

  // A stable identity is mandatory for the {podcastId, guid} unique index. Most
  // feeds carry <guid>; fall back to the enclosure URL when they don't.
  const guid = text(item['guid']) ?? enclosureUrl;
  if (!guid) return null;

  const title = text(item['title']);
  if (!title) return null;

  const transcripts: ParsedTranscript[] = [];
  for (const node of asArray(item['podcast:transcript'])) {
    const url = attr(node, 'url');
    const type = attr(node, 'type');
    if (url && type) transcripts.push({ url, type, language: attr(node, 'language') });
  }

  const persons = collectPersons(item['podcast:person']);

  const chaptersUrl = attr(item['podcast:chapters'], 'url');
  const chaptersType = attr(item['podcast:chapters'], 'type');
  const enclosureLength = parseInteger(attr(enclosure, 'length'));

  return {
    guid,
    title,
    description: text(item['content:encoded']) ?? text(item['description']),
    summary: text(item['itunes:summary']),
    enclosureUrl,
    enclosureType: attr(enclosure, 'type'),
    enclosureLength,
    duration: parseDuration(text(item['itunes:duration'])),
    pubDate: parseDate(text(item['pubDate'])),
    season: parseInteger(text(item['itunes:season'])),
    episodeNumber: parseInteger(text(item['itunes:episode'])),
    episodeType: parseEpisodeType(text(item['itunes:episodeType'])),
    image: attr(item['itunes:image'], 'href'),
    explicit: parseBool(text(item['itunes:explicit'])),
    chapters: chaptersUrl && chaptersType ? { url: chaptersUrl, type: chaptersType } : undefined,
    transcripts,
    persons,
  };
}

// ── Network ─────────────────────────────────────────────────────────────────────

/** Read an upstream stream into a Buffer, aborting past `maxBytes`. */
async function readCapped(stream: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    stream.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        stream.destroy();
        reject(new Error(`RssConnector: feed exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export interface FetchOptions {
  etag?: string;
  lastModified?: string;
}

/**
 * Fetch and parse a podcast RSS feed. Honors conditional GET — when the caller
 * passes a stored `etag`/`lastModified` and the upstream replies `304`, the
 * result is `{ notModified: true }` and the body is never read.
 *
 * @throws SsrfRejection  — the feed URL targets a blocked/private address.
 * @throws UpstreamError  — upstream/network failure (mapped to 502 upstream).
 * @throws Error          — non-2xx status, oversized body, or unparseable feed.
 */
/**
 * Pure parse of a feed XML string into the normalised `{ show, episodes[] }`.
 * No I/O — drives the unit tests directly. Throws if there is no `<channel>`.
 */
export function parseFeedXml(xml: string): { show: ParsedShow; episodes: ParsedEpisode[] } {
  const parsed = parser.parse(xml) as unknown;
  const channel = asRecord(asRecord(asRecord(parsed)?.['rss'])?.['channel']);
  if (!channel) {
    throw new Error('RssConnector: no <channel> in feed');
  }

  const show = normaliseShow(channel);

  const episodes: ParsedEpisode[] = [];
  for (const rawItem of asArray(channel['item'])) {
    if (episodes.length >= MAX_EPISODES_PER_FEED) {
      logger.warn('[podcasts] feed exceeded episode cap; truncating', { cap: MAX_EPISODES_PER_FEED });
      break;
    }
    const record = asRecord(rawItem);
    if (!record) continue;
    const episode = normaliseEpisode(record);
    if (episode) episodes.push(episode);
  }

  return { show, episodes };
}

export async function fetchAndParse(
  feedUrl: string,
  options: FetchOptions = {},
  deps: { fetch?: SafeFetchFn } = {},
): Promise<RssFetchResult> {
  const doFetch = deps.fetch ?? safeFetch;
  const headers: Record<string, string> = { Accept: 'application/rss+xml, application/xml, text/xml' };
  if (options.etag) headers['If-None-Match'] = options.etag;
  if (options.lastModified) headers['If-Modified-Since'] = options.lastModified;

  let result;
  try {
    result = await doFetch(feedUrl, { headers });
  } catch (err) {
    if (err instanceof SsrfRejection || err instanceof UpstreamError) throw err;
    throw new UpstreamError(`RssConnector: fetch failed for ${feedUrl}`);
  }

  if (result.status === 304) {
    result.response.destroy();
    return { notModified: true, etag: options.etag, lastModified: options.lastModified };
  }

  if (result.status < 200 || result.status >= 300) {
    result.response.destroy();
    throw new Error(`RssConnector: upstream returned ${result.status} for ${feedUrl}`);
  }

  const body = await readCapped(result.response, MAX_FEED_BYTES);

  const etagHeader = result.headers['etag'];
  const lastModifiedHeader = result.headers['last-modified'];

  const { show, episodes } = parseFeedXml(body.toString('utf-8'));

  return {
    notModified: false,
    etag: typeof etagHeader === 'string' ? etagHeader : undefined,
    lastModified: typeof lastModifiedHeader === 'string' ? lastModifiedHeader : undefined,
    show,
    episodes,
  };
}
