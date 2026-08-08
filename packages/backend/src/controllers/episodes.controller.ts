/**
 * Episodes controller — episode detail (with resolved hosts/guests) plus the
 * user-scoped resume surface: save playback progress and list "continue
 * listening". Auth writes resolve the user via `getRequiredOxyUserId`.
 */

import type { Response } from 'express';
import { isLiveEntityId } from '@oxyhq/db';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { updateEpisodeProgressRequestSchema, updateEpisodeRequestSchema } from '@syra/shared-types';
import {
  findEpisodeById,
  findEpisodeProgress,
  findEpisodesByIds,
  listContinueListening,
  updateEpisode as updateEpisodeRow,
  upsertEpisodeProgress,
} from '../db/podcasts/episodes';
import { findPodcastById } from '../db/podcasts/podcasts';
import { loadEpisodePersons, loadShowArtwork, toEpisodeDtos } from '../db/podcasts/hydrate';
import type { EpisodeRow } from '../db/podcasts/serialize';
import { getParam, parseClampedLimit } from '../utils/reqParams';
import { resolvePersons, makeOxyUsersFetcher } from '../services/podcasts/resolvePersons';
import { oxy } from '../oxyClient';

const CONTINUE_LIMIT_MIN = 1;
const CONTINUE_LIMIT_DEFAULT = 20;
const CONTINUE_LIMIT_MAX = 50;

/**
 * GET /api/episodes/:id — episode detail, including chapters/transcripts and
 * persons resolved to person/artist links, plus the caller's saved progress.
 */
export async function getEpisode(req: AuthRequest, res: Response): Promise<void> {
  const id = getParam(req, 'id');
  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  const episode = await findEpisodeById(id);
  if (!episode || episode.status === 'unavailable') {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }

  // The inline credits are a child table now, so they are read here and handed
  // to the resolver. Resolved in parallel with the parent show's artwork: a
  // cover-less episode inherits the show's in the serialized DTO.
  const credits = (await loadEpisodePersons([episode.id])).get(episode.id) ?? [];

  const [persons, artwork] = await Promise.all([
    resolvePersons(credits, makeOxyUsersFetcher(oxy)),
    loadShowArtwork([episode]),
  ]);

  const progress = req.user?.id ? await findEpisodeProgress(req.user.id, id) : undefined;
  const [dto] = await toEpisodeDtos([episode], artwork);

  res.json({
    data: {
      episode: dto,
      persons,
      progressSec: progress?.positionSec,
      completed: progress?.completed,
    },
  });
}

/**
 * PUT /api/episodes/:id/progress — upsert the caller's playback position.
 */
export async function updateEpisodeProgress(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');
  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  const parsed = updateEpisodeProgressRequestSchema.safeParse({ ...req.body, episodeId: id });
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid progress payload' });
    return;
  }
  const { positionSec, durationSec, completed } = parsed.data;

  const progress = await upsertEpisodeProgress(userId, id, {
    positionSec: Math.max(0, positionSec),
    completed: completed ?? false,
    ...(durationSec === undefined ? {} : { durationSec: Math.max(0, durationSec) }),
  });

  res.json({ ok: true, positionSec: progress.positionSec, completed: progress.completed });
}

/**
 * GET /api/episodes/continue — the caller's in-progress (not completed)
 * episodes, most recently played first, joined with the episode rows.
 */
export async function getContinueListening(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const limit = parseClampedLimit(req.query.limit, { min: CONTINUE_LIMIT_MIN, max: CONTINUE_LIMIT_MAX, fallback: CONTINUE_LIMIT_DEFAULT });

  const progressRows = await listContinueListening(userId, limit);
  if (progressRows.length === 0) {
    res.json({ data: [] });
    return;
  }

  const episodeRows = await findEpisodesByIds(progressRows.map((row) => row.episodeId));
  // Distinct parent shows resolved in ONE query so cover-less episodes inherit
  // their show's artwork without an N+1.
  const dtos = await toEpisodeDtos(episodeRows);
  const dtoById = new Map(dtos.map((dto) => [dto.id, dto]));

  const data = progressRows.flatMap((row) => {
    const episode = dtoById.get(row.episodeId);
    if (!episode) return [];
    return [
      {
        episode,
        progressSec: row.positionSec,
        durationSec: row.durationSec,
        completed: row.completed,
      },
    ];
  });

  res.json({ data });
}

/**
 * PATCH /api/episodes/:id — edit an episode on a Syra-hosted show you own.
 *
 * Ownership is resolved through the STORED episode's `podcastId`, and requires the same
 * `source === 'syra'` + owner rule as `uploadEpisode`: RSS-mirrored episodes are a copy
 * of an external feed, so edits here would be silently overwritten by the next refresh.
 * The body is parsed against the shared schema, never spread, so `podcastId`, `guid`,
 * `status`, and the cached-audio/HLS fields stay unreachable.
 */
export async function updateEpisode(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');

  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  const parsed = updateEpisodeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    return;
  }

  const episode = await findEpisodeById(id);
  if (!episode) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }

  const podcast = await findPodcastById(episode.podcastId);
  if (!podcast || podcast.source !== 'syra' || podcast.ownerOxyUserId !== userId) {
    res.status(403).json({ error: 'You do not own this podcast' });
    return;
  }

  const updates = parsed.data;

  // Explicit field-by-field assignment — the parsed object is never spread onto the row.
  const values: Parameters<typeof updateEpisodeRow>[1] = {};
  if (updates.title !== undefined) values.title = updates.title;
  if (updates.description !== undefined) values.description = updates.description;
  if (updates.summary !== undefined) values.summary = updates.summary;
  if (updates.season !== undefined) values.season = updates.season;
  if (updates.episodeNumber !== undefined) values.episodeNumber = updates.episodeNumber;
  if (updates.episodeType !== undefined) values.episodeType = updates.episodeType;
  /**
   * `image_id` is a foreign key to `image_assets`, so an id naming no asset is
   * `23503` rather than the string Mongo stored. `isLiveEntityId` rejects a
   * malformed one here; a well-formed id for an asset that does not exist still
   * reaches the constraint, and that is the caller's 500 to avoid by uploading
   * the cover first — the same contract `uploads.controller` already has.
   */
  if (updates.image !== undefined) {
    if (!isLiveEntityId(updates.image)) {
      res.status(400).json({ error: 'Invalid image id' });
      return;
    }
    values.imageId = updates.image;
  }
  if (updates.explicit !== undefined) values.explicit = updates.explicit;

  const updated = await updateEpisodeRow(id, values);
  if (!updated) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }

  const artwork = await loadShowArtwork([updated]);
  const [dto] = await toEpisodeDtos([updated], artwork);
  res.json({ data: { episode: dto } });
}

/**
 * Load an episode on a Syra-hosted show the caller owns, or send the matching error.
 * Returns undefined once a response has been sent.
 */
async function loadOwnedEpisodeOrRespond(
  req: AuthRequest,
  res: Response
): Promise<EpisodeRow | undefined> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');

  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return undefined;
  }

  const episode = await findEpisodeById(id);
  if (!episode) {
    res.status(404).json({ error: 'Episode not found' });
    return undefined;
  }

  const podcast = await findPodcastById(episode.podcastId);
  if (!podcast || podcast.source !== 'syra' || podcast.ownerOxyUserId !== userId) {
    res.status(403).json({ error: 'You do not own this podcast' });
    return undefined;
  }

  return episode;
}

/**
 * POST /api/episodes/:id/unpublish — hide a single episode.
 *
 * Soft by design: `status: 'unavailable'` is the episode-level equivalent of a track's
 * `isAvailable:false`. The row, its media and every listener's saved progress stay
 * intact, so republishing is lossless. Note this reuses the same `status` field that
 * carries processing state, so an episode still importing should not be unpublished —
 * publishing restores it to 'ready'.
 */
export async function unpublishEpisode(req: AuthRequest, res: Response): Promise<void> {
  const episode = await loadOwnedEpisodeOrRespond(req, res);
  if (!episode) return;

  await updateEpisodeRow(episode.id, { status: 'unavailable' });
  res.json({ data: { id: episode.id, status: 'unavailable' } });
}

/** POST /api/episodes/:id/publish — undo `unpublishEpisode`. */
export async function publishEpisode(req: AuthRequest, res: Response): Promise<void> {
  const episode = await loadOwnedEpisodeOrRespond(req, res);
  if (!episode) return;

  await updateEpisodeRow(episode.id, { status: 'ready' });
  res.json({ data: { id: episode.id, status: 'ready' } });
}
