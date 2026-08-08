import { Response, NextFunction } from 'express';
import { isLiveEntityId } from '@oxyhq/db';
import {
  addToQueueRequestSchema,
  removeFromQueueRequestSchema,
  replaceQueueRequestSchema,
  playableRefSchema,
  type PlayableItem,
  type PlayableRef,
  type PlayableTrack,
  type Queue,
  type QueueWithMetadata,
  type Track,
} from '@syra/shared-types';
import { z } from 'zod';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { and, inArray } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import { getDb, isPostgresConnected } from '../db/postgres';
import { tracks as tracksTable } from '../db/schema/catalog';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { loadImageVariants, toTrackDtos } from '../db/catalog/hydrate';
import { findQueueableUploads } from '../db/creators/uploads';
import { toUploadTrackDto, uploadImageIds } from '../db/creators/serialize';
import {
  getQueue,
  setQueue,
  addTracks as addTracksToQueue,
  removeTracks as removeTracksFromQueue,
  reorderQueue,
  clearQueue as clearUserQueue,
  setCurrentIndex,
} from '../services/queueService';
import { playableTrackFilter } from '../db/catalog/visibility';

/**
 * The queue is addressed by (kind, id), because two collections back it.
 *
 * Everything below resolves a `PlayableRef` through the authority for its kind
 * and NEVER by trying one and falling back to the other: a catalog ref goes
 * through `playableTrackFilter`, and an upload ref is looked up with
 * `ownerOxyUserId` in the same query, so somebody else's locker item is not
 * addressable at all — it resolves to nothing, exactly as a nonexistent id does.
 */
function refKey(ref: PlayableRef | PlayableItem): string {
  return `${ref.kind}:${ref.id}`;
}

interface ResolvedRefs {
  byKey: Map<string, PlayableItem>;
  /** Refs that resolved to nothing: unplayable, not owned, or not there. */
  missing: PlayableRef[];
}

async function resolvePlayableRefs(
  refs: PlayableRef[],
  userId: string,
): Promise<ResolvedRefs> {
  const trackIds = [...new Set(refs.filter((ref) => ref.kind === 'track').map((ref) => ref.id))];
  const uploadIds = [...new Set(refs.filter((ref) => ref.kind === 'upload').map((ref) => ref.id))];

  // ONE id guard for both kinds now that both are Postgres rows. `uploadIds`
  // used to be filtered by `ObjectId.isValid` because the locker was still
  // Mongo; a locker id is a uuid v7 since the port, which that test rejects.
  const validTrackIds = trackIds.filter(isLiveEntityId);
  const validUploadIds = uploadIds.filter(isLiveEntityId);

  const [trackRows, uploads] = await Promise.all([
    // `inArray` with an empty list generates `in ()`, a Postgres syntax error
    // rather than an empty result — so the length guard is load-bearing here in
    // a way the Mongo `$in` did not need.
    validTrackIds.length
      ? getDb()
          .select(publicColumns(tracksTable, PROTECTED_COLUMNS_BY_TABLE))
          .from(tracksTable)
          .where(and(playableTrackFilter(), inArray(tracksTable.id, validTrackIds)))
      : Promise.resolve([]),
    findQueueableUploads(validUploadIds, userId),
  ]);

  const byKey = new Map<string, PlayableItem>();

  const formattedTracks: PlayableTrack[] = (await toTrackDtos(trackRows)).map(
    (track: Track): PlayableTrack => ({ ...track, kind: 'track' }),
  );
  for (const track of formattedTracks) {
    byKey.set(refKey(track), track);
  }

  // One image lookup for the whole page, not one per row — the same batch shape
  // `toTrackDtos` uses above.
  const uploadImages = await loadImageVariants(uploads.flatMap(uploadImageIds));
  for (const upload of uploads) {
    const item = toUploadTrackDto(upload, uploadImages);
    byKey.set(refKey(item), item);
  }

  const seen = new Set<string>();
  const missing: PlayableRef[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    if (byKey.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(ref);
  }

  return { byKey, missing };
}

/** Re-expand the caller's ordering (duplicates included) from the resolved set. */
function orderedItemsFromRefs(refs: PlayableRef[], resolved: ResolvedRefs): PlayableItem[] {
  const items: PlayableItem[] = [];
  for (const ref of refs) {
    const item = resolved.byKey.get(refKey(ref));
    if (item) items.push(item);
  }
  return items;
}

/** `PUT /api/queue/reorder` has no request schema of its own; it reuses the shared ref. */
const reorderQueueBodySchema = z.object({
  refs: z.array(playableRefSchema).min(1),
});

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
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const parsed = addToQueueRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid queue payload', details: parsed.error.issues });
    }

    const { refs, position } = parsed.data;
    if (refs.length === 0) {
      return res.status(400).json({ error: 'refs must be a non-empty array' });
    }

    const resolved = await resolvePlayableRefs(refs, userId);
    const orderedTracks = orderedItemsFromRefs(refs, resolved);

    if (orderedTracks.length === 0) {
      return res.status(404).json({ error: 'No playable items found' });
    }

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
    if (!isPostgresConnected()) {
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

    const { refs, current, context } = parsed.data;
    if (current >= refs.length) {
      return res.status(400).json({ error: 'Current index out of bounds' });
    }

    // Both kinds pass through here, and both are Postgres rows since Task 13.
    // `isLiveEntityId` accepts a uuid v7 and a carried-over 24-char ObjectId
    // hex; `ObjectId.isValid` alone would 400 every row minted since the
    // cutover, of either kind.
    const invalidRefs = refs.filter((ref) => !isLiveEntityId(ref.id));
    if (invalidRefs.length > 0) {
      return res.status(400).json({ error: 'Some refs are invalid', invalidRefs });
    }

    const resolved = await resolvePlayableRefs(refs, userId);

    // Replacing a queue is all-or-nothing: a partial queue would silently drop
    // whatever the caller was actually trying to play. An upload ref belonging to
    // somebody else lands here as "not playable", indistinguishable from one that
    // does not exist — which is the point.
    if (resolved.missing.length > 0) {
      return res.status(404).json({
        error: 'Some items are not playable',
        unavailableRefs: resolved.missing,
      });
    }

    const queue: Queue = {
      current,
      tracks: orderedItemsFromRefs(refs, resolved),
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

    const parsed = removeFromQueueRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid queue payload', details: parsed.error.issues });
    }

    const { refs } = parsed.data;
    if (refs.length === 0) {
      return res.status(400).json({ error: 'refs must be a non-empty array' });
    }

    const updatedQueue = await removeTracksFromQueue(userId, refs);

    if (!updatedQueue) {
      return res.status(503).json({ error: 'Failed to update queue' });
    }

    res.json({
      queue: updatedQueue,
      removed: refs.length,
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

    const parsed = reorderQueueBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid queue payload', details: parsed.error.issues });
    }

    const { refs } = parsed.data;

    const queue = await getQueue(userId);
    if (!queue || queue.tracks.length === 0) {
      return res.status(400).json({ error: 'Queue is empty' });
    }

    // Reorder addresses items ALREADY in the queue — already resolved, already
    // owner-checked — so it needs no database read, only that every ref names one.
    const queueKeys = new Set(queue.tracks.map(refKey));
    const invalidRefs = refs.filter((ref) => !queueKeys.has(refKey(ref)));
    if (invalidRefs.length > 0) {
      return res.status(400).json({
        error: 'Some refs are not in the queue',
        invalidRefs,
      });
    }

    const updatedQueue = await reorderQueue(userId, refs);

    if (!updatedQueue) {
      return res.status(503).json({ error: 'Failed to reorder queue' });
    }

    res.json({
      queue: updatedQueue,
      reordered: refs.length,
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
