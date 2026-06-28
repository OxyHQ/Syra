/**
 * Episodes controller — episode detail (with resolved hosts/guests) plus the
 * user-scoped resume surface: save playback progress and list "continue
 * listening". Auth writes resolve the user via `getRequiredOxyUserId`.
 */

import mongoose from 'mongoose';
import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { updateEpisodeProgressRequestSchema } from '@syra/shared-types';
import { EpisodeModel } from '../models/Episode';
import { EpisodeProgressModel } from '../models/EpisodeProgress';
import { PodcastModel } from '../models/Podcast';
import { getParam } from '../utils/reqParams';
import { serializeEpisode } from '../services/podcasts/podcastSerializers';
import { PODCAST_ARTWORK_PROJECTION, loadShowArtworkByPodcastId } from '../services/podcasts/episodeShowArtwork';
import { resolvePersons, makeOxyUsersFetcher } from '../services/podcasts/resolvePersons';
import { oxy } from '../oxyClient';

const CONTINUE_LIMIT_DEFAULT = 20;
const CONTINUE_LIMIT_MAX = 50;

function clampLimit(raw: unknown): number {
  const parsed = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return CONTINUE_LIMIT_DEFAULT;
  return Math.min(CONTINUE_LIMIT_MAX, Math.max(1, parsed));
}

/**
 * GET /api/episodes/:id — episode detail, including chapters/transcripts and
 * persons resolved to Person/Artist links, plus the caller's saved progress.
 */
export async function getEpisode(req: AuthRequest, res: Response): Promise<void> {
  const id = getParam(req, 'id');
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  const episode = await EpisodeModel.findById(id).lean();
  if (!episode || episode.status === 'unavailable') {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }

  // Resolve persons and the parent show's artwork in parallel: a cover-less
  // episode inherits the show's artwork in the serialized DTO.
  const [persons, podcastArtwork] = await Promise.all([
    resolvePersons(episode.persons, makeOxyUsersFetcher(oxy)),
    PodcastModel.findById(episode.podcastId).select(PODCAST_ARTWORK_PROJECTION).lean(),
  ]);

  let progressSec: number | undefined;
  let completed: boolean | undefined;
  if (req.user?.id) {
    const progress = await EpisodeProgressModel.findOne({ oxyUserId: req.user.id, episodeId: id })
      .select('positionSec completed')
      .lean();
    if (progress) {
      progressSec = progress.positionSec;
      completed = progress.completed;
    }
  }

  res.json({
    data: { episode: serializeEpisode(episode, podcastArtwork ?? undefined), persons, progressSec, completed },
  });
}

/**
 * PUT /api/episodes/:id/progress — upsert the caller's playback position.
 */
export async function updateEpisodeProgress(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  const parsed = updateEpisodeProgressRequestSchema.safeParse({ ...req.body, episodeId: id });
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid progress payload' });
    return;
  }
  const { positionSec, durationSec, completed } = parsed.data;

  const set: Record<string, unknown> = {
    positionSec: Math.max(0, positionSec),
    completed: completed ?? false,
  };
  if (durationSec !== undefined) set.durationSec = Math.max(0, durationSec);

  const progress = await EpisodeProgressModel.findOneAndUpdate(
    { oxyUserId: userId, episodeId: id },
    { $set: set },
    { upsert: true, new: true },
  );

  res.json({ ok: true, positionSec: progress?.positionSec ?? positionSec, completed: progress?.completed ?? false });
}

/**
 * GET /api/episodes/continue — the caller's in-progress (not completed)
 * episodes, most recently played first, joined with the episode documents.
 */
export async function getContinueListening(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const limit = clampLimit(req.query.limit);

  const progressRows = await EpisodeProgressModel.find({ oxyUserId: userId, completed: false })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();

  if (progressRows.length === 0) {
    res.json({ data: [] });
    return;
  }

  const episodeIds = progressRows.map((row) => row.episodeId);
  const episodes = await EpisodeModel.find({ _id: { $in: episodeIds }, status: { $ne: 'unavailable' } }).lean();
  const episodeById = new Map(episodes.map((episode) => [episode._id.toString(), episode]));
  // Distinct parent shows resolved in ONE query so cover-less episodes inherit
  // their show's artwork without an N+1.
  const showArtwork = await loadShowArtworkByPodcastId(episodes);

  const data = progressRows
    .map((row) => {
      const episode = episodeById.get(row.episodeId.toString());
      if (!episode) return null;
      return {
        episode: serializeEpisode(episode, showArtwork.get(episode.podcastId.toString())),
        progressSec: row.positionSec,
        durationSec: row.durationSec,
        completed: row.completed,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  res.json({ data });
}
