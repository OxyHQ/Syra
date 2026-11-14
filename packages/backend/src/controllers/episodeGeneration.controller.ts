/**
 * Generated episodes over REST, for Syra Studio:
 *
 *   POST /api/podcasts/:id/episodes/generate   ask for one (owner only)
 *   GET  /api/podcasts/:id/generations         a show's generations (owner only)
 *   GET  /api/podcasts/episodes/:id/generation one generation (owner only)
 *
 * Ownership is decided in SQL (`findPodcastForOwner`), and "not yours" and
 * "no such show" are one answer, as on every other creator route. The MCP tools
 * call the same service (`services/podcasts/generation/request.ts`).
 */

import type { Response } from 'express';
import { isLiveEntityId } from '@oxy.so/db';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import { generateEpisodeRequestSchema } from '@syra/shared-types';
import { findPodcastForOwner } from '../db/podcasts/podcasts';
import {
  findGeneration,
  listGenerationsForPodcast,
  toEpisodeGenerationDto,
} from '../db/podcasts/generations';
import { loadShowContext, toEpisodeDtos } from '../db/podcasts/hydrate';
import { withFileTask } from '../services/oxyFiles/taskAuthority';
import { requestEpisodeGeneration } from '../services/podcasts/generation/request';
import { getParam } from '../utils/reqParams';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

const NOT_OWNED = 'You do not own this podcast';

export async function generateEpisode(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');
  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }
  const parsed = generateEpisodeRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid generation request', details: parsed.error.issues });
    return;
  }
  const show = await findPodcastForOwner(id, userId);
  if (!show) {
    res.status(403).json({ error: NOT_OWNED });
    return;
  }

  try {
    const result = await requestEpisodeGeneration({
      show,
      requesterId: userId,
      request: parsed.data,
      // The owner's session is on this request, so the finished audio becomes
      // their own Oxy file, exactly as an upload does.
      fileTask: (episodeId, write) => withFileTask(req, episodeId, write),
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.code, message: result.message });
      return;
    }
    const shows = await loadShowContext([result.episode]);
    const [episode] = await toEpisodeDtos([result.episode], userId, shows);
    res
      .status(202)
      .json({ data: { episode, generation: toEpisodeGenerationDto(result.generation) } });
  } catch (err) {
    logger.error('[generation] could not start an episode generation', {
      podcastId: id,
      err: describeErrorSafely(err),
    });
    res.status(500).json({ error: 'Failed to start the episode generation' });
  }
}

export async function listPodcastGenerations(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');
  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }
  if (!(await findPodcastForOwner(id, userId))) {
    res.status(403).json({ error: NOT_OWNED });
    return;
  }
  const rows = await listGenerationsForPodcast(id, 50);
  res.json({ data: rows.map(toEpisodeGenerationDto) });
}

export async function getEpisodeGeneration(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const episodeId = getParam(req, 'id');
  if (!isLiveEntityId(episodeId)) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }
  const generation = await findGeneration(episodeId);
  // Somebody else's generation reads exactly like none at all.
  if (!generation || !(await findPodcastForOwner(generation.podcastId, userId))) {
    res.status(404).json({ error: 'Generation not found' });
    return;
  }
  res.json({ data: toEpisodeGenerationDto(generation) });
}
