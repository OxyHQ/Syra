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
  type EpisodeWithShow,
} from '../db/podcasts/episodes';
import { deleteEpisodeCompletely } from '../services/podcasts/deletePodcast';
import { loadEpisodePersons, loadShowContext, toEpisodeDtos } from '../db/podcasts/hydrate';
import { viewerCanReadShow, viewerOwnsShow } from '../db/podcasts/visibility';
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
 *
 * The SHOW is consulted, which it never was before: this handler read the
 * episode row alone and tested its own `status`, so no show-level state reached
 * episode detail at all — a takedown, an unpublish and (once it existed)
 * `private` were all invisible here, and every episode of a hidden show kept
 * serving its full detail page on a direct link.
 *
 * `viewerCanReadShow` is the same rule `findPodcastForViewer` applies in SQL,
 * evaluated in TypeScript because the show is already in hand from the join.
 */
export async function getEpisode(req: AuthRequest, res: Response): Promise<void> {
  const id = getParam(req, 'id');
  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  const found = await findEpisodeById(id);
  if (!found || !viewerCanReadShow(found.show, req.user?.id)) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }
  const { episode, show } = found;

  // The owner sees an episode in every state; everyone else sees only `ready`
  // ones — the same rule `episodeVisibilityFilter` states for a show's list,
  // applied to the single-episode read that never had it.
  const isOwner = viewerOwnsShow(show, req.user?.id);
  if (!isOwner && episode.status !== 'ready') {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }

  // The inline credits are a child table now, so they are read here and handed
  // to the resolver. Resolved in parallel with the parent show's artwork: a
  // cover-less episode inherits the show's in the serialized DTO.
  const credits = (await loadEpisodePersons([episode.id])).get(episode.id) ?? [];

  const [persons, shows] = await Promise.all([
    resolvePersons(credits, makeOxyUsersFetcher(oxy)),
    loadShowContext([episode]),
  ]);

  const progress = req.user?.id ? await findEpisodeProgress(req.user.id, id) : undefined;
  const [dto] = await toEpisodeDtos([episode], req.user?.id, shows);

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
 *
 * The existence check is new, and it closes an oracle of a different shape from
 * the others: this handler accepted ANY well-formed id and answered `{ ok: true
 * }`, writing an `episode_progress` row against whatever the caller sent. A
 * foreign key made a nonexistent id a 500 while a real one — private, hidden,
 * anyone's — was a 200, so the status code sorted ids into "exists" and "does
 * not" without the caller ever being able to see the episode.
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

  const found = await findEpisodeById(id);
  if (!found || !viewerCanReadShow(found.show, userId)) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }

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

  // Viewer-filtered: an entry whose show has since gone private or been
  // unpublished drops out of the list here rather than in the client. The
  // `episode_progress` row survives, so it comes back if the show does.
  const episodeRows = await findEpisodesByIds(progressRows.map((row) => row.episodeId), userId);
  // Distinct parent shows resolved in ONE query so cover-less episodes inherit
  // their show's artwork without an N+1.
  const dtos = await toEpisodeDtos(episodeRows, userId);
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

  // The show arrives WITH the episode, so ownership is answered from the row
  // rather than from a second unfiltered read of `podcasts`.
  const found = await findEpisodeById(id);
  if (!found || found.show.source !== 'syra' || !viewerOwnsShow(found.show, userId)) {
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

  const shows = await loadShowContext([updated]);
  const [dto] = await toEpisodeDtos([updated], userId, shows);
  res.json({ data: { episode: dto } });
}

/**
 * Load an episode on a Syra-hosted show the caller owns, or send the matching error.
 * Returns undefined once a response has been sent.
 *
 * Returns the SHOW beside the episode — `findEpisodeById` already joins it, so
 * this costs nothing — because `deleteEpisode` has to consult show-level state
 * that the two publish verbs do not. Handing back the episode alone would force
 * the one caller that needs the show to re-read it through a second, unfiltered
 * query, which is the shape `findEpisodeById`'s own doc comment exists to make
 * unspellable.
 */
async function loadOwnedEpisodeOrRespond(
  req: AuthRequest,
  res: Response
): Promise<EpisodeWithShow | undefined> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');

  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return undefined;
  }

  const found = await findEpisodeById(id);
  if (!found || found.show.source !== 'syra' || !viewerOwnsShow(found.show, userId)) {
    res.status(403).json({ error: 'You do not own this podcast' });
    return undefined;
  }

  return found;
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
  const found = await loadOwnedEpisodeOrRespond(req, res);
  if (!found) return;

  await updateEpisodeRow(found.episode.id, { status: 'unavailable' });
  res.json({ data: { id: found.episode.id, status: 'unavailable' } });
}

/** POST /api/episodes/:id/publish — undo `unpublishEpisode`. */
export async function publishEpisode(req: AuthRequest, res: Response): Promise<void> {
  const found = await loadOwnedEpisodeOrRespond(req, res);
  if (!found) return;

  await updateEpisodeRow(found.episode.id, { status: 'ready' });
  res.json({ data: { id: found.episode.id, status: 'ready' } });
}

/**
 * DELETE /api/episodes/:id — permanently delete one episode of a Syra-hosted
 * show you own.
 *
 * A hard delete, for the reason `deletePodcast` is one: `unpublish` already
 * occupies the reversible half of this space, and a second verb that also only
 * hides would leave a creator with no way to actually remove an episode. What
 * goes with the row is its HLS ladder, its transcript, its credits, its AES key,
 * any outstanding ingest ticket, and every listener's saved position in it — the
 * cascade is enumerated in `db/podcasts/delete.ts`. The audio goes first; the
 * ordering and its consequences are `services/podcasts/deletePodcast.ts`.
 *
 * The parent show's `episode_count` and `last_episode_at` move in the same
 * transaction as the row, recomputed rather than decremented — see
 * `deleteEpisodeRow`.
 *
 * A show under a platform takedown is a 409, matching `deletePodcast`: the
 * takedown is a record of what was published, and a creator deleting its
 * episodes one at a time would erase exactly what `deletePodcast` refuses to let
 * them erase whole.
 */
export async function deleteEpisode(req: AuthRequest, res: Response): Promise<void> {
  const found = await loadOwnedEpisodeOrRespond(req, res);
  if (!found) return;

  if (found.show.status === 'removed') {
    res.status(409).json({
      error: 'Podcast removed',
      message: 'This show was removed by the platform and its episodes cannot be deleted',
    });
    return;
  }

  const result = await deleteEpisodeCompletely(found.episode.id);
  if (!result) {
    // The row went between the owner check and the delete. Nothing was removed
    // by THIS request, so it does not report that it removed anything.
    res.status(404).json({ error: 'Episode not found' });
    return;
  }

  res.json({
    data: {
      id: found.episode.id,
      podcastId: found.show.id,
      objectsDeleted: result.objectsDeleted,
    },
  });
}
