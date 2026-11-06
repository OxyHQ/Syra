import type { Request, Response } from 'express';
import { env } from '../config/env';
import { importFeed } from '../services/podcasts/podcastImportService';
import { logger } from '../utils/logger';

/**
 * GET /api/podcasts/apple/:collectionId — the Syra show for an Apple Podcasts show.
 *
 * Apple's id names the show, and Apple's lookup gives its feed. The feed is
 * imported (or the show already known is found by its feed) and the answer is
 * the show's id and its page on Syra. Public: no session is needed to ask.
 * Clients reach it through `@syra.fm/sdk` (`resolveApplePodcast`).
 */

const APPLE_LOOKUP = 'https://itunes.apple.com/lookup';
const USER_AGENT = 'Syra/1.0 (+https://syra.fm)';
const LOOKUP_TIMEOUT_MS = 8_000;

const webOrigin = () => env.FRONTEND_URL.replace(/\/+$/, '');

/** The feed Apple publishes for a collection id, or `null` when Apple has no such podcast. */
async function appleFeedUrl(collectionId: string): Promise<string | null> {
  const response = await fetch(`${APPLE_LOOKUP}?id=${collectionId}&entity=podcast`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as {
    results?: { collectionId?: unknown; feedUrl?: unknown }[];
  };
  const show = body.results?.find((result) => String(result.collectionId) === collectionId);
  return typeof show?.feedUrl === 'string' ? show.feedUrl : null;
}

export async function openApplePodcast(req: Request, res: Response): Promise<void> {
  const collectionId = String(req.params.collectionId);
  if (!/^\d{1,15}$/.test(collectionId)) {
    res.status(400).json({
      error: { code: 'invalid_collection_id', message: 'An Apple collection id is numeric' },
    });
    return;
  }

  let feedUrl: string | null;
  try {
    feedUrl = await appleFeedUrl(collectionId);
  } catch (err) {
    logger.warn('[podcasts] Apple lookup failed', { collectionId, err: String(err) });
    res.status(502).json({ error: { code: 'lookup_failed', message: 'Apple did not answer' } });
    return;
  }
  if (!feedUrl) {
    res
      .status(404)
      .json({ error: { code: 'not_found', message: 'Apple has no podcast with this id' } });
    return;
  }

  try {
    const { podcast } = await importFeed(feedUrl);
    res.json({
      data: {
        podcastId: podcast.id,
        url: `${webOrigin()}/podcasts/${encodeURIComponent(podcast.id)}`,
      },
    });
  } catch (err) {
    logger.warn('[podcasts] Apple show import failed', { collectionId, err: String(err) });
    res
      .status(502)
      .json({ error: { code: 'import_failed', message: 'The show could not be imported' } });
  }
}
