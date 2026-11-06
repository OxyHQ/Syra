import type { Request, Response } from 'express';
import { env } from '../config/env';
import { resolveAppleShow } from '../services/podcasts/applePodcastShow';
import { logger } from '../utils/logger';

/**
 * GET /api/podcasts/apple/:collectionId — the Syra show for an Apple Podcasts show.
 *
 * Public: a link is followed by a browser with no session. Clients reach it
 * through `@syra.fm/sdk` (`resolveApplePodcast`).
 */
const webOrigin = () => env.FRONTEND_URL.replace(/\/+$/, '');

export async function openApplePodcast(req: Request, res: Response): Promise<void> {
  const collectionId = String(req.params.collectionId);
  try {
    const resolution = await resolveAppleShow(collectionId);
    if ('notFound' in resolution) {
      res
        .status(404)
        .json({ error: { code: 'not_found', message: 'Apple has no podcast with this id' } });
      return;
    }
    res.json({
      data: {
        podcastId: resolution.podcastId,
        url: `${webOrigin()}/podcasts/${encodeURIComponent(resolution.podcastId)}`,
      },
    });
  } catch (err) {
    if (err instanceof TypeError) {
      res.status(400).json({ error: { code: 'invalid_collection_id', message: err.message } });
      return;
    }
    logger.warn('[podcasts] Apple show resolve failed', {
      collectionId,
      err: err instanceof Error ? err.message : String(err),
    });
    res
      .status(502)
      .json({ error: { code: 'import_failed', message: 'The show could not be resolved' } });
  }
}
