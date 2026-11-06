import { importFeed as importPodcastFeed } from './podcastImportService';
import { logger } from '../../utils/logger';

/**
 * An Apple Podcasts show, as Syra knows it.
 *
 * Apple's collection id names the show; Apple's public lookup gives its feed,
 * and the feed is imported (or the show already known is found by it). The
 * dependencies are parameters, so the rules are tested without touching the
 * network or the importer.
 */

const APPLE_LOOKUP = 'https://itunes.apple.com/lookup';
const USER_AGENT = 'Syra/1.0 (+https://syra.fm)';
const LOOKUP_TIMEOUT_MS = 8_000;

export interface AppleShowDeps {
  /** The feed Apple publishes for a collection id, or `null` when Apple has no such podcast. */
  lookupFeedUrl(collectionId: string): Promise<string | null>;
  /** Imports the feed, or finds the show already known by it. */
  importFeed(feedUrl: string): Promise<{ podcast: { id: string } }>;
}

export type AppleShowResolution = { podcastId: string } | { notFound: true };

export const defaultAppleShowDeps: AppleShowDeps = {
  lookupFeedUrl: appleFeedUrl,
  importFeed: async (feedUrl) => importPodcastFeed(feedUrl),
};

/** Resolves an Apple collection id to the Syra show for it. A non-numeric id is the caller's error. */
export async function resolveAppleShow(
  collectionId: string,
  deps: AppleShowDeps = defaultAppleShowDeps,
): Promise<AppleShowResolution> {
  if (!/^\d{1,15}$/.test(collectionId)) {
    throw new TypeError('An Apple Podcasts collection id is numeric');
  }
  const feedUrl = await deps.lookupFeedUrl(collectionId);
  if (!feedUrl) return { notFound: true };
  const { podcast } = await deps.importFeed(feedUrl);
  return { podcastId: podcast.id };
}

/** The feed Apple publishes for a collection id, or `null` when Apple has no such podcast. */
export async function appleFeedUrl(collectionId: string): Promise<string | null> {
  const response = await fetch(`${APPLE_LOOKUP}?id=${collectionId}&entity=podcast`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) {
    logger.warn('[podcasts] Apple lookup non-OK', { collectionId, status: response.status });
    throw new Error(`Apple lookup answered ${response.status}`);
  }
  const body = (await response.json()) as {
    results?: { collectionId?: unknown; feedUrl?: unknown }[];
  };
  const show = body.results?.find((result) => String(result.collectionId) === collectionId);
  return typeof show?.feedUrl === 'string' ? show.feedUrl : null;
}
