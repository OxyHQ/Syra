/**
 * The polite, cached JSON client the enrichment sources share.
 *
 * Enrichment talks to three public APIs that cost nothing and ask for one thing
 * in return: that we do not hammer them. Wikimedia and MetaBrainz both publish
 * the same expectation — identify yourself with a real User-Agent, keep it to
 * roughly one request a second, and cache what you already asked for. This
 * module is where all three obligations live, so no individual client can forget
 * one.
 *
 * It is deliberately NOT a general-purpose fetch. Every host it will talk to is
 * hard-coded in {@link ENRICHMENT_HOSTS}: these requests are built from
 * identifiers found in a stranger's uploaded file, and a client that followed
 * whatever URL those identifiers produced would be a request forgery primitive
 * with extra steps. Image BYTES are a different matter and do not go through
 * here — they go through `mirrorCatalogImage`, which already does the DNS and
 * IP-range validation that fetching a remote-supplied URL requires.
 */

import { logger } from '../../utils/logger';

/**
 * Identifies Syra to the upstream APIs, with a contact URL.
 *
 * Wikimedia's User-Agent policy and MetaBrainz's terms both require this and
 * both block generic or absent agents. A default `node-fetch`-shaped agent gets
 * a 403 from Wikimedia, so this is load-bearing rather than courtesy.
 */
export const ENRICHMENT_USER_AGENT = 'SyraCatalogEnrichment/1.0 (+https://syra.fm)';

/** The only hosts enrichment may talk to. */
export const ENRICHMENT_HOSTS: readonly string[] = [
  'www.wikidata.org',
  'commons.wikimedia.org',
  'coverartarchive.org',
  // Answers "which artist is credited on the recording this ISRC names", which
  // is the id every other host here is keyed by. See `musicbrainzLookup.ts`.
  'musicbrainz.org',
];

/**
 * Minimum gap between requests, applied ACROSS all enrichment hosts.
 *
 * One per second is MusicBrainz's published limit and the ceiling Wikimedia asks
 * unauthenticated clients to stay under. Applying it globally rather than
 * per-host is the conservative reading and costs nothing: enrichment is a
 * background job with no user waiting on it.
 */
export const ENRICHMENT_MIN_REQUEST_INTERVAL_MS = 1000;

/** How long a successful response stays cached. */
export const ENRICHMENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Cap on cached entries, so a long-running task cannot grow without bound. */
const ENRICHMENT_CACHE_MAX_ENTRIES = 2000;

const REQUEST_TIMEOUT_MS = 15_000;

// ── Rate limiting ───────────────────────────────────────────────────────────

/**
 * A promise chain rather than a `setInterval`.
 *
 * A module-level interval would keep the Node event loop alive and hang the test
 * process (the `timer.unref?.()` rule in AGENTS.md exists for exactly that), and
 * there is nothing to poll here — each request simply waits until enough time
 * has passed since the previous one finished starting.
 */
let requestChain: Promise<void> = Promise.resolve();
let lastRequestStartedAt = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Serialize onto the shared chain and wait out the remaining interval. */
async function takeRateLimitSlot(): Promise<void> {
  const wait = requestChain.then(async () => {
    const sinceLast = Date.now() - lastRequestStartedAt;
    const remaining = ENRICHMENT_MIN_REQUEST_INTERVAL_MS - sinceLast;
    if (remaining > 0) await delay(remaining);
    lastRequestStartedAt = Date.now();
  });
  // The chain must not break on a rejection, or every later request inherits it.
  requestChain = wait.catch(() => undefined);
  return wait;
}

// ── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

function readCache(url: string): unknown | undefined {
  const entry = cache.get(url);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(url);
    return undefined;
  }
  // Refresh insertion order so the eviction below is least-recently-USED rather
  // than least-recently-written.
  cache.delete(url);
  cache.set(url, entry);
  return entry.value;
}

function writeCache(url: string, value: unknown): void {
  cache.set(url, { expiresAt: Date.now() + ENRICHMENT_CACHE_TTL_MS, value });
  while (cache.size > ENRICHMENT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Drop every cached response. Exported for tests, which must not share state. */
export function clearEnrichmentCache(): void {
  cache.clear();
  lastRequestStartedAt = 0;
}

// ── Fetch ───────────────────────────────────────────────────────────────────

export class EnrichmentHostError extends Error {}

/**
 * The network call, behind a swappable reference.
 *
 * Same seam the catalog image mirror uses
 * (`setCatalogImageMirrorImplementationForTests`), for the same reason: the
 * parsers below have to be tested against what these APIs REALLY return, and a
 * test suite that reached the network would be slow, flaky, and would hammer
 * services that ask us not to. The committed payloads in
 * `__fixtures__/enrichment-payloads.json` are real captured responses, so the
 * parsers face the genuine shape without a request being made.
 */
export type EnrichmentFetch = (url: string) => Promise<unknown | undefined>;

let enrichmentFetch: EnrichmentFetch | undefined;

export function setEnrichmentFetchForTests(implementation?: EnrichmentFetch): void {
  enrichmentFetch = implementation;
  clearEnrichmentCache();
}

function assertAllowedHost(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EnrichmentHostError(`enrichment: not a URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new EnrichmentHostError(`enrichment: refusing non-HTTPS request to ${parsed.host}`);
  }
  if (!ENRICHMENT_HOSTS.includes(parsed.host)) {
    throw new EnrichmentHostError(
      `enrichment: ${parsed.host} is not an allowed enrichment host (${ENRICHMENT_HOSTS.join(', ')})`,
    );
  }
}

/**
 * GET a JSON document from one of the allowed hosts.
 *
 * Returns `undefined` rather than throwing for every outcome that means "this
 * source has nothing for us" — a 404, a rate-limit response, a timeout, a body
 * that is not JSON. Enrichment is best-effort by nature: it runs in the
 * background, it fills gaps, and a source being down must leave the profile
 * exactly as it was rather than fail an upload that already succeeded. A
 * disallowed host is the one case that DOES throw, because that is a programming
 * error rather than a remote condition.
 */
export async function fetchEnrichmentJson(url: string): Promise<unknown | undefined> {
  // The host check runs FIRST and runs under test too. It is a guard against a
  // URL built from a stranger's file, so a test seam that bypassed it would be
  // testing a different function from the one that ships.
  assertAllowedHost(url);

  const cached = readCache(url);
  if (cached !== undefined) return cached;

  if (enrichmentFetch) {
    const value = await enrichmentFetch(url);
    if (value !== undefined) writeCache(url, value);
    return value;
  }

  await takeRateLimitSlot();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': ENRICHMENT_USER_AGENT,
        Accept: 'application/json',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      // 404 is the normal "no data for this identifier" answer from every one of
      // these APIs, so it is logged at debug rather than as a problem.
      logger[response.status === 404 ? 'debug' : 'warn'](
        `[enrichment] ${response.status} from ${new URL(url).host}`,
        { url },
      );
      return undefined;
    }

    const value: unknown = await response.json();
    writeCache(url, value);
    return value;
  } catch (err) {
    logger.warn('[enrichment] request failed', {
      url,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Small shared readers ────────────────────────────────────────────────────

/** Narrow an unknown to a plain object without asserting a shape. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Strip HTML from a value that arrives as markup.
 *
 * Commons returns the attribution (`extmetadata.Artist`) as an HTML fragment —
 * typically an anchor to the author's user page. The credit has to be shown as
 * text next to the image, and injecting a remote source's markup into our own
 * pages is not something to do casually, so the tags come out and the text stays.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
