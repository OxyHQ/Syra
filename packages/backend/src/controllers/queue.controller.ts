import { Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import {
  Queue,
  QueueWithMetadata,
  AddToQueueRequest,
  ReplaceQueueRequest,
  replaceQueueRequestSchema,
} from '@syra/shared-types';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { isDatabaseConnected } from '../utils/database';
import { TrackModel } from '../models/Track';
import { toApiFormatArray, formatTracksWithCoverArt } from '../utils/musicHelpers';
import {
  getQueue,
  setQueue,
  addTracks as addTracksToQueue,
  removeTracks as removeTracksFromQueue,
  reorderQueue,
  clearQueue as clearUserQueue,
  setCurrentIndex,
} from '../services/queueService';
import { playableTrackFilter, resolveCatalogPlaybackOptions } from '../utils/catalogVisibility';

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function orderedTracksFromIds(trackIds: string[], tracks: Queue['tracks']): Queue['tracks'] {
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const orderedTracks: Queue['tracks'] = [];

  for (const trackId of trackIds) {
    const track = trackById.get(trackId);
    if (track) {
      orderedTracks.push(track);
    }
  }

  return orderedTracks;
}

function missingTrackIds(trackIds: string[], tracks: Queue['tracks']): string[] {
  const availableTrackIds = new Set(tracks.map((track) => track.id));
  return uniqueValues(trackIds).filter((trackId) => !availableTrackIds.has(trackId));
}

/**
 * GET /api/queue
 * Get user's queue
 */
export const getQueueHandler = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const queue = await getQueue(userId);

    if (!queue) {
      return res.json({
        current: -1,
        tracks: [],
        previous: [],
        next: [],
        total: 0,
      } as QueueWithMetadata);
    }

    // Split tracks into previous, current, and next
    const previous: typeof queue.tracks = [];
    const next: typeof queue.tracks = [];
    const currentTrack = queue.current >= 0 && queue.current < queue.tracks.length
      ? queue.tracks[queue.current]
      : null;

    if (queue.current >= 0) {
      previous.push(...queue.tracks.slice(0, queue.current));
      next.push(...queue.tracks.slice(queue.current + 1));
    } else {
      next.push(...queue.tracks);
    }

    const queueWithMetadata: QueueWithMetadata = {
      ...queue,
      previous,
      next,
      total: queue.tracks.length,
    };

    res.json(queueWithMetadata);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/queue/add
 * Add tracks to queue
 */
export const addToQueue = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const playbackOptions = await resolveCatalogPlaybackOptions(userId);

    const { trackIds, position }: AddToQueueRequest = req.body;

    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return res.status(400).json({ error: 'trackIds must be a non-empty array' });
    }

    // Validate track IDs
    const validTrackIds = trackIds.filter(tid => mongoose.Types.ObjectId.isValid(tid));
    if (validTrackIds.length === 0) {
      return res.status(400).json({ error: 'No valid track IDs provided' });
    }

    // Fetch tracks from database
    const tracks = await TrackModel.find(playableTrackFilter({
      _id: { $in: validTrackIds },
    }, playbackOptions)).lean();

    if (tracks.length === 0) {
      return res.status(404).json({ error: 'No valid tracks found' });
    }

    // Format tracks for API
    const formattedTracks: Queue['tracks'] = await formatTracksWithCoverArt(tracks);
    const orderedTracks = orderedTracksFromIds(validTrackIds, formattedTracks);

    // Add to queue
    const updatedQueue = await addTracksToQueue(userId, orderedTracks, position);

    if (!updatedQueue) {
      return res.status(503).json({ error: 'Failed to update queue' });
    }

    res.json({
      queue: updatedQueue,
      added: orderedTracks.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/queue
 * Replace the user's queue with an ordered playback context.
 */
export const replaceQueue = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const parsed = replaceQueueRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid queue payload',
        details: parsed.error.issues,
      });
    }

    const { trackIds, current, context }: ReplaceQueueRequest = parsed.data;
    if (current >= trackIds.length) {
      return res.status(400).json({ error: 'Current index out of bounds' });
    }

    const invalidTrackIds = uniqueValues(trackIds).filter((trackId) => !mongoose.Types.ObjectId.isValid(trackId));
    if (invalidTrackIds.length > 0) {
      return res.status(400).json({
        error: 'Some track IDs are invalid',
        invalidTrackIds,
      });
    }

    const playbackOptions = await resolveCatalogPlaybackOptions(userId);
    const uniqueTrackIds = uniqueValues(trackIds);
    const tracks = await TrackModel.find(playableTrackFilter({
      _id: { $in: uniqueTrackIds },
    }, playbackOptions)).lean();
    const formattedTracks: Queue['tracks'] = await formatTracksWithCoverArt(tracks);
    const unavailableTrackIds = missingTrackIds(trackIds, formattedTracks);

    if (unavailableTrackIds.length > 0) {
      return res.status(404).json({
        error: 'Some tracks are not playable',
        unavailableTrackIds,
      });
    }

    const queue: Queue = {
      current,
      tracks: orderedTracksFromIds(trackIds, formattedTracks),
      context,
    };
    const success = await setQueue(userId, queue);

    if (!success) {
      return res.status(503).json({ error: 'Failed to replace queue' });
    }

    res.json({ queue });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/queue/remove
 * Remove tracks from queue
 */
export const removeFromQueue = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { trackIds } = req.body;

    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return res.status(400).json({ error: 'trackIds must be a non-empty array' });
    }

    const updatedQueue = await removeTracksFromQueue(userId, trackIds);

    if (!updatedQueue) {
      return res.status(503).json({ error: 'Failed to update queue' });
    }

    res.json({
      queue: updatedQueue,
      removed: trackIds.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/queue/reorder
 * Reorder queue tracks
 */
export const reorderQueueHandler = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { trackIds } = req.body;

    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return res.status(400).json({ error: 'trackIds must be a non-empty array' });
    }

    const queue = await getQueue(userId);
    if (!queue || queue.tracks.length === 0) {
      return res.status(400).json({ error: 'Queue is empty' });
    }

    // Validate all track IDs exist in queue
    const queueTrackIds = new Set(queue.tracks.map(t => t.id));
    const invalidTrackIds = trackIds.filter(tid => !queueTrackIds.has(tid));
    if (invalidTrackIds.length > 0) {
      return res.status(400).json({
        error: 'Some track IDs are not in the queue',
        invalidTrackIds,
      });
    }

    const updatedQueue = await reorderQueue(userId, trackIds);

    if (!updatedQueue) {
      return res.status(503).json({ error: 'Failed to reorder queue' });
    }

    res.json({
      queue: updatedQueue,
      reordered: trackIds.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/queue/clear
 * Clear queue
 */
export const clearQueueHandler = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const success = await clearUserQueue(userId);

    if (!success) {
      return res.status(503).json({ error: 'Failed to clear queue' });
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/queue/current
 * Set current track index
 */
export const setCurrentTrack = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { index } = req.body;

    if (typeof index !== 'number' || index < 0) {
      return res.status(400).json({ error: 'index must be a non-negative number' });
    }

    const queue = await getQueue(userId);
    if (!queue) {
      return res.status(400).json({ error: 'Queue not found' });
    }

    if (index >= queue.tracks.length) {
      return res.status(400).json({ error: 'Index out of bounds' });
    }

    const updatedQueue = await setCurrentIndex(userId, index);

    if (!updatedQueue) {
      return res.status(503).json({ error: 'Failed to update current track' });
    }

    res.json({
      queue: updatedQueue,
      currentIndex: index,
    });
  } catch (error) {
    next(error);
  }
};
