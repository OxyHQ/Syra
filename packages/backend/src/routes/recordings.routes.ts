import { Router, Response } from 'express';
import { isLiveEntityId } from '@oxyhq/db';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import {
  findRecordingById,
  listPublicRecordings,
  updateRecording,
  type PublicRecordingSort,
} from '../db/rooms/recordings';
import { RecordingAccess, RecordingStatus } from '../db/rooms/types';
import { describeErrorSafely } from '../utils/error';
import { getParam } from '../utils/reqParams';
import { logger } from '../utils/logger';
import { getRecordingPresignedUrl, deleteRecordingFromSpaces } from '../utils/spaces';

const router = Router();

/**
 * List public recordings
 * GET /api/recordings
 * Query params: sortBy ('popular' | 'recent'), limit (default 10, max 50)
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { sortBy = 'recent', limit = '10' } = req.query;
    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 10, 1), 50);

    const sort: PublicRecordingSort = sortBy === 'popular' ? 'popular' : 'recent';

    const recordings = await listPublicRecordings(sort, limitNum);

    res.json({ recordings });
  } catch (error) {
    logger.error('Error listing recordings:', { userId: req.user?.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error listing recordings',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Get a single recording with presigned playback URL
 * GET /api/recordings/:recordingId
 */
router.get('/:recordingId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const recordingId = getParam(req, 'recordingId');

    const recording = isLiveEntityId(recordingId)
      ? await findRecordingById(recordingId)
      : undefined;
    if (!recording || recording.status === RecordingStatus.DELETED) {
      return res.status(404).json({ message: 'Recording not found' });
    }

    if (recording.status !== RecordingStatus.READY) {
      return res.status(400).json({ message: `Recording is not ready (status: ${recording.status})` });
    }

    // Access check
    const isHost = userId === recording.host;
    if (!isHost && recording.access === RecordingAccess.PARTICIPANTS) {
      if (!userId || !recording.participantIds.includes(userId)) {
        return res.status(403).json({ message: 'This recording is only available to participants' });
      }
    }

    const playbackUrl = await getRecordingPresignedUrl(recording.objectKey);

    res.json({
      recording,
      playbackUrl,
    });
  } catch (error) {
    logger.error('Error fetching recording:', { userId: req.user?.id, recordingId: req.params.recordingId, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error fetching recording',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Update recording access level (host only)
 * PATCH /api/recordings/:recordingId
 */
router.patch('/:recordingId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const recordingId = getParam(req, 'recordingId');
    const { access } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const existing = isLiveEntityId(recordingId) ? await findRecordingById(recordingId) : undefined;
    if (!existing || existing.status === RecordingStatus.DELETED) {
      return res.status(404).json({ message: 'Recording not found' });
    }

    if (existing.host !== userId) {
      return res.status(403).json({ message: 'Only the host can update recording settings' });
    }

    if (!access || !Object.values(RecordingAccess).includes(access)) {
      return res.status(400).json({ message: 'Invalid access value. Must be "public" or "participants".' });
    }

    const recording = await updateRecording(existing.id, { access });

    logger.info(`Recording ${recordingId} access updated to ${access} by ${userId}`);

    res.json({ recording });
  } catch (error) {
    logger.error('Error updating recording:', { userId: req.user?.id, recordingId: req.params.recordingId, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error updating recording',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Delete a recording (host only)
 * DELETE /api/recordings/:recordingId
 *
 * A soft delete — the row moves to `status: 'deleted'` and the audio leaves S3.
 * The row itself stays, which is why `recordings.room_id` is `ON DELETE SET
 * NULL` rather than `CASCADE`: neither deleting the room nor deleting the
 * recording ever removes the other.
 */
router.delete('/:recordingId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const recordingId = getParam(req, 'recordingId');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const recording = isLiveEntityId(recordingId)
      ? await findRecordingById(recordingId)
      : undefined;
    if (!recording || recording.status === RecordingStatus.DELETED) {
      return res.status(404).json({ message: 'Recording not found' });
    }

    if (recording.host !== userId) {
      return res.status(403).json({ message: 'Only the host can delete recordings' });
    }

    // Delete file from Spaces
    try {
      await deleteRecordingFromSpaces(recording.objectKey);
    } catch (err) {
      logger.warn(`Failed to delete recording file from Spaces (may already be gone):`, { err: describeErrorSafely(err) });
    }

    await updateRecording(recording.id, { status: RecordingStatus.DELETED });

    logger.info(`Recording ${recordingId} deleted by ${userId}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting recording:', { userId: req.user?.id, recordingId: req.params.recordingId, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error deleting recording',
      error: describeErrorSafely(error),
    });
  }
});

export default router;
