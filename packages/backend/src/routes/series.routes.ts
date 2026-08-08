import { Router, Response } from 'express';
import multer from 'multer';
import { isLiveEntityId } from '@oxyhq/db';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import {
  appendSeriesEpisode,
  createSeries,
  deleteSeries,
  findSeriesById,
  findSeriesView,
  toSeriesView,
  updateSeries,
  type UpdateSeriesInput,
} from '../db/rooms/series';
import { findHouseWithMembers, hasRole, canAccessRooms, canSeeHouse } from '../db/rooms/houses';
import { createRoom } from '../db/rooms/rooms';
import { stripInternalStreamFields } from '../db/rooms/serialize';
import {
  HouseMemberRole,
  OwnerType,
  RecurrenceType,
  RoomStatus,
  RoomType,
  SpeakerPermission,
} from '../db/rooms/types';
import { describeErrorSafely } from '../utils/error';
import { getParam } from '../utils/reqParams';
import { logger } from '../utils/logger';
import { processImage } from '../utils/imageProcessor';
import { uploadObject, deleteObject, getAgoraSeriesCoverKey, cdnUrlToKey } from '../utils/spaces';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed. Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}`));
    }
  }
});

const router = Router();

/**
 * Whether `userId` may modify `series` — its creator, or an admin+ of the house
 * that owns it.
 *
 * A profile-owned series has no house to escalate through, so the creator is the
 * only answer. Four routes asked this question with the same eight lines each;
 * it is one function because a permission check copied four times is four
 * chances to diverge, not because the expression is long.
 */
async function canManageSeries(
  series: { createdBy: string; houseId: string | null },
  userId: string,
): Promise<boolean> {
  if (series.createdBy === userId) return true;
  if (!series.houseId) return false;

  const owning = await findHouseWithMembers(series.houseId);
  return owning !== undefined && hasRole(owning.members, userId, HouseMemberRole.ADMIN);
}

/**
 * Create a series
 * POST /api/series
 *
 * If houseId is provided, the user must be HOST or higher in that house.
 * Otherwise, the series belongs to the user's profile.
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const {
      title,
      description,
      coverImage,
      houseId,
      recurrence,
      roomTemplate,
    } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ message: 'Title is required' });
    }

    if (!recurrence || typeof recurrence !== 'object') {
      return res.status(400).json({ message: 'Recurrence schedule is required' });
    }

    if (!roomTemplate || typeof roomTemplate !== 'object') {
      return res.status(400).json({ message: 'Room template is required' });
    }

    // Validate recurrence
    if (!recurrence.type || !Object.values(RecurrenceType).includes(recurrence.type)) {
      return res.status(400).json({ message: 'Invalid recurrence type' });
    }

    if (!recurrence.time || typeof recurrence.time !== 'string' || !/^\d{2}:\d{2}$/.test(recurrence.time)) {
      return res.status(400).json({ message: 'Recurrence time is required in HH:mm format' });
    }

    if (!recurrence.timezone || typeof recurrence.timezone !== 'string') {
      return res.status(400).json({ message: 'Recurrence timezone is required' });
    }

    // Validate roomTemplate
    if (!roomTemplate.titlePattern || typeof roomTemplate.titlePattern !== 'string') {
      return res.status(400).json({ message: 'Room template titlePattern is required' });
    }

    // If houseId provided, validate house membership
    if (houseId && typeof houseId === 'string') {
      const owning = isLiveEntityId(houseId) ? await findHouseWithMembers(houseId) : undefined;
      if (!owning) {
        return res.status(404).json({ message: 'House not found' });
      }

      if (!hasRole(owning.members, userId, HouseMemberRole.HOST)) {
        return res.status(403).json({ message: 'You must be a host or higher in this house to create series' });
      }
    }

    // Resolve room template type
    const templateType: RoomType = roomTemplate.type && Object.values(RoomType).includes(roomTemplate.type)
      ? roomTemplate.type
      : RoomType.TALK;

    const templateSpeakerPermission: SpeakerPermission =
      roomTemplate.speakerPermission && Object.values(SpeakerPermission).includes(roomTemplate.speakerPermission)
        ? roomTemplate.speakerPermission
        : SpeakerPermission.INVITED;

    const row = await createSeries({
      title: title.trim(),
      description: description ? String(description).trim() : null,
      coverImage: coverImage ? String(coverImage).trim() : null,
      houseId: houseId || null,
      createdBy: userId,
      recurrence: {
        type: recurrence.type,
        dayOfWeek: typeof recurrence.dayOfWeek === 'number' ? recurrence.dayOfWeek : undefined,
        dayOfMonth: typeof recurrence.dayOfMonth === 'number' ? recurrence.dayOfMonth : undefined,
        time: recurrence.time,
        timezone: recurrence.timezone,
      },
      roomTemplate: {
        titlePattern: roomTemplate.titlePattern.trim(),
        type: templateType,
        description: roomTemplate.description ? String(roomTemplate.description).trim() : undefined,
        maxParticipants: roomTemplate.maxParticipants && typeof roomTemplate.maxParticipants === 'number'
          ? Math.min(Math.max(roomTemplate.maxParticipants, 1), 10000)
          : 100,
        speakerPermission: templateSpeakerPermission,
        tags: Array.isArray(roomTemplate.tags)
          ? roomTemplate.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
          : [],
      },
    });

    logger.info(`Series created: ${row.id} by ${userId}${houseId ? ` (house=${houseId})` : ''}`);

    res.status(201).json({
      message: 'Series created successfully',
      series: toSeriesView(row, []),
    });
  } catch (error) {
    logger.error('Error creating series:', { userId: req.user?.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error creating series',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Get series details
 * GET /api/series/:id
 *
 * A house-owned series inherits its house's visibility: it describes the
 * house's schedule, so reading it is the same disclosure as listing the
 * house's series. A profile-owned series has no house to gate on.
 */
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    const series = isLiveEntityId(id) ? await findSeriesView(id) : undefined;

    if (!series) {
      return res.status(404).json({ message: 'Series not found' });
    }

    if (series.houseId) {
      const owning = await findHouseWithMembers(series.houseId);
      if (!owning || !canSeeHouse(owning.house, owning.members, userId)) {
        return res.status(404).json({ message: 'Series not found' });
      }
      if (!canAccessRooms(owning.house, owning.members, userId)) {
        return res.status(403).json({ message: 'Only members can view this house\'s series' });
      }
    }

    res.json({ series });
  } catch (error) {
    logger.error('Error fetching series:', { userId: req.user?.id, seriesId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error fetching series',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Update series (creator or house admin+)
 * PATCH /api/series/:id
 */
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');
    const { title, description, coverImage, recurrence, roomTemplate, isActive } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const existing = isLiveEntityId(id) ? await findSeriesById(id) : undefined;

    if (!existing) {
      return res.status(404).json({ message: 'Series not found' });
    }

    if (!(await canManageSeries(existing, userId))) {
      return res.status(403).json({ message: 'You do not have permission to update this series' });
    }

    /**
     * `null` CLEARS and `undefined` LEAVES ALONE. The Mongoose original assigned
     * `undefined` to clear, which `save()` turned into `$unset`; drizzle DROPS an
     * `undefined`-valued key, so carrying that spelling forward would make
     * "remove the cover image" silently keep the old one.
     */
    const update: UpdateSeriesInput = {};

    if (title !== undefined && typeof title === 'string' && title.trim().length > 0) {
      update.title = title.trim();
    }
    if (description !== undefined) {
      update.description = description ? String(description).trim() : null;
    }
    if (coverImage !== undefined) {
      update.coverImage = coverImage ? String(coverImage).trim() : null;
    }
    if (typeof isActive === 'boolean') {
      update.isActive = isActive;
    }

    // Update recurrence if provided
    if (recurrence && typeof recurrence === 'object') {
      if (recurrence.type && Object.values(RecurrenceType).includes(recurrence.type)) {
        update.recurrenceType = recurrence.type;
      }
      if (typeof recurrence.dayOfWeek === 'number') {
        update.recurrenceDayOfWeek = recurrence.dayOfWeek;
      }
      if (typeof recurrence.dayOfMonth === 'number') {
        update.recurrenceDayOfMonth = recurrence.dayOfMonth;
      }
      if (recurrence.time && typeof recurrence.time === 'string' && /^\d{2}:\d{2}$/.test(recurrence.time)) {
        update.recurrenceTime = recurrence.time;
      }
      if (recurrence.timezone && typeof recurrence.timezone === 'string') {
        update.recurrenceTimezone = recurrence.timezone;
      }
    }

    // Update roomTemplate if provided
    if (roomTemplate && typeof roomTemplate === 'object') {
      if (roomTemplate.titlePattern && typeof roomTemplate.titlePattern === 'string') {
        update.roomTemplateTitlePattern = roomTemplate.titlePattern.trim();
      }
      if (roomTemplate.type && Object.values(RoomType).includes(roomTemplate.type)) {
        update.roomTemplateType = roomTemplate.type;
      }
      if (roomTemplate.description !== undefined) {
        update.roomTemplateDescription = roomTemplate.description
          ? String(roomTemplate.description).trim()
          : null;
      }
      if (roomTemplate.maxParticipants && typeof roomTemplate.maxParticipants === 'number') {
        update.roomTemplateMaxParticipants = Math.min(Math.max(roomTemplate.maxParticipants, 1), 10000);
      }
      if (roomTemplate.speakerPermission && Object.values(SpeakerPermission).includes(roomTemplate.speakerPermission)) {
        update.roomTemplateSpeakerPermission = roomTemplate.speakerPermission;
      }
      if (roomTemplate.tags !== undefined && Array.isArray(roomTemplate.tags)) {
        update.roomTemplateTags = roomTemplate.tags.map((t: unknown) => String(t).trim()).filter(Boolean);
      }
    }

    await updateSeries(existing.id, update);

    logger.info(`Series updated: ${id} by ${userId}`);

    res.json({
      message: 'Series updated successfully',
      series: await findSeriesView(existing.id),
    });
  } catch (error) {
    logger.error('Error updating series:', { userId: req.user?.id, seriesId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error updating series',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Delete series (creator or house admin+)
 * DELETE /api/series/:id
 */
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const series = isLiveEntityId(id) ? await findSeriesById(id) : undefined;

    if (!series) {
      return res.status(404).json({ message: 'Series not found' });
    }

    if (!(await canManageSeries(series, userId))) {
      return res.status(403).json({ message: 'You do not have permission to delete this series' });
    }

    await deleteSeries(series.id);

    logger.info(`Series deleted: ${id} by ${userId}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting series:', { userId: req.user?.id, seriesId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error deleting series',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Generate the next episode room from the series template
 * POST /api/series/:id/generate-episode
 */
router.post('/:id/generate-episode', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');
    const { scheduledStart } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const series = isLiveEntityId(id) ? await findSeriesById(id) : undefined;

    if (!series) {
      return res.status(404).json({ message: 'Series not found' });
    }

    if (!series.isActive) {
      return res.status(400).json({ message: 'Series is not active' });
    }

    if (!(await canManageSeries(series, userId))) {
      return res.status(403).json({ message: 'You do not have permission to generate episodes for this series' });
    }

    // Resolve the scheduled start date
    let scheduledStartDate: Date;
    if (scheduledStart) {
      scheduledStartDate = new Date(scheduledStart);
      if (isNaN(scheduledStartDate.getTime())) {
        return res.status(400).json({ message: 'Invalid scheduledStart date' });
      }
    } else {
      // Default: schedule for now
      scheduledStartDate = new Date();
    }

    const episodeNumber = series.nextEpisodeNumber;

    // Generate the title from the pattern (replace {n} with episode number)
    const title = series.roomTemplateTitlePattern.replace(/\{n\}/g, String(episodeNumber));

    // Determine ownerType and houseId
    const ownerType = series.houseId ? OwnerType.HOUSE : OwnerType.PROFILE;

    // Create the room from the template
    const room = await createRoom({
      title,
      description: series.roomTemplateDescription,
      host: userId,
      type: series.roomTemplateType as RoomType,
      ownerType,
      houseId: series.houseId,
      status: RoomStatus.SCHEDULED,
      participants: [],
      speakers: [userId],
      maxParticipants: series.roomTemplateMaxParticipants,
      scheduledStart: scheduledStartDate,
      tags: series.roomTemplateTags,
      speakerPermission: series.roomTemplateSpeakerPermission as SpeakerPermission,
      seriesId: series.id,
    });

    // Record the episode in the series and advance its counter.
    await appendSeriesEpisode(series.id, room.id, scheduledStartDate, episodeNumber);

    logger.info(`Episode ${episodeNumber} generated for series ${id}: room ${room.id}`);

    res.status(201).json({
      message: 'Episode generated successfully',
      // Through the allowlist rather than returned raw. The four credential
      // columns are null on a freshly-created room, so nothing is withheld that
      // a caller used to receive — but a create response is not a reason to
      // bypass the one funnel every other room response goes through.
      room: stripInternalStreamFields(room),
      episodeNumber,
    });
  } catch (error) {
    logger.error('Error generating episode:', { userId: req.user?.id, seriesId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error generating episode',
      error: describeErrorSafely(error),
    });
  }
});

// ---------------------------------------------------------------------------
// Series cover upload
// ---------------------------------------------------------------------------

/**
 * Upload series cover image
 * POST /api/series/:id/cover
 */
router.post('/:id/cover', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ message: 'No file provided' });

    const series = isLiveEntityId(id) ? await findSeriesById(id) : undefined;
    if (!series) return res.status(404).json({ message: 'Series not found' });

    if (!(await canManageSeries(series, userId))) {
      return res.status(403).json({ message: 'You do not have permission to update this series' });
    }

    const { buffer, contentType } = await processImage(req.file.buffer, 'cover');
    const objectKey = getAgoraSeriesCoverKey(id as string);

    const oldCoverKey = cdnUrlToKey(series.coverImage);
    if (oldCoverKey && oldCoverKey !== objectKey) {
      deleteObject(oldCoverKey).catch(() => {});
    }

    const cdnUrl = await uploadObject(objectKey, buffer, contentType, 'public-read');
    await updateSeries(series.id, { coverImage: cdnUrl });

    res.json({ coverImage: cdnUrl });
  } catch (error) {
    logger.error('Error uploading series cover:', { seriesId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({ message: 'Error uploading cover', error: describeErrorSafely(error) });
  }
});

export default router;
