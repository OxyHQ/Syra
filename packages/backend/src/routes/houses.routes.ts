import { Router, Response } from 'express';
import multer from 'multer';
import { isLiveEntityId } from '@oxyhq/db';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import {
  addHouseMember,
  canAccessRooms,
  canSeeHouse,
  createHouse,
  deleteHouse,
  findHouseMembers,
  findHouseWithMembers,
  findMember,
  findMembersByHouseIds,
  getMemberRole,
  hasRole,
  isMember,
  isSelfJoinable,
  listHouses,
  removeHouseMember,
  updateHouse,
  updateHouseMemberRole,
  visibilityOf,
} from '../db/rooms/houses';
import { listRooms } from '../db/rooms/rooms';
import { listActiveSeriesForHouse } from '../db/rooms/series';
import { serializeHouseFor, stripInternalStreamFields } from '../db/rooms/serialize';
import {
  DEFAULT_HOUSE_VISIBILITY,
  HouseDiscovery,
  HouseJoin,
  HouseMemberRole,
  HouseRooms,
  RoomStatus,
  RoomType,
  type HouseVisibility,
} from '../db/rooms/types';
import { describeErrorSafely } from '../utils/error';
import { getParam } from '../utils/reqParams';
import { logger } from '../utils/logger';
import { processImage } from '../utils/imageProcessor';
import { uploadObject, deleteObject, getAgoraHouseAvatarKey, getAgoraHouseCoverKey, cdnUrlToKey } from '../utils/spaces';

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
 * Narrow a client-supplied value to one of an axis's allowed strings, or
 * `undefined` if it is not one. An unrecognised value is never silently coerced
 * to a default — callers reject it.
 */
function parseAxis<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Merge a client-supplied `visibility` object onto a base, validating each axis.
 *
 * Only axes present in the input are touched, so PATCH callers change one axis
 * without restating the others (base = the house's current visibility) and POST
 * callers omit axes to accept the defaults (base = {@link DEFAULT_HOUSE_VISIBILITY}).
 * A present-but-invalid axis is a 400, never a silent default — a visibility
 * control that quietly ignored a value would be a control that lies.
 */
function resolveVisibility(
  input: unknown,
  base: HouseVisibility,
): { visibility: HouseVisibility } | { error: string } {
  if (input === undefined) return { visibility: base };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'visibility must be an object' };
  }

  const raw = input as Record<string, unknown>;
  const result: HouseVisibility = { ...base };

  if (raw.discovery !== undefined) {
    const discovery = parseAxis(raw.discovery, Object.values(HouseDiscovery));
    if (!discovery) return { error: 'Invalid visibility.discovery' };
    result.discovery = discovery;
  }
  if (raw.rooms !== undefined) {
    const rooms = parseAxis(raw.rooms, Object.values(HouseRooms));
    if (!rooms) return { error: 'Invalid visibility.rooms' };
    result.rooms = rooms;
  }
  if (raw.join !== undefined) {
    const join = parseAxis(raw.join, Object.values(HouseJoin));
    if (!join) return { error: 'Invalid visibility.join' };
    result.join = join;
  }

  return { visibility: result };
}

/**
 * Create a house
 * POST /api/houses
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { name, description, avatar, coverImage, tags, visibility } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const resolvedVisibility = resolveVisibility(visibility, DEFAULT_HOUSE_VISIBILITY);
    if ('error' in resolvedVisibility) {
      return res.status(400).json({ message: resolvedVisibility.error });
    }

    // The creator's `owner` membership is inserted in the same transaction as
    // the house — the roster is a second table now, so "a house always has an
    // owner" is a property of two writes rather than one document.
    const { house, members } = await createHouse({
      name: name.trim(),
      description: description ? String(description).trim() : null,
      avatar: avatar ? String(avatar).trim() : null,
      coverImage: coverImage ? String(coverImage).trim() : null,
      createdBy: userId,
      visibility: resolvedVisibility.visibility,
      tags: Array.isArray(tags) ? tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [],
    });

    logger.info(`House created: ${house.id} by ${userId}`);

    res.status(201).json({
      message: 'House created successfully',
      house: serializeHouseFor(house, members, userId),
    });
  } catch (error) {
    logger.error('Error creating house:', { userId: req.user?.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error creating house',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * List discoverable houses (paginated, cursor-based)
 * GET /api/houses
 *
 * Returns every `listed` house, plus any house the requester is a member of —
 * which is how a member still finds their own `unlisted` or `hidden` houses
 * here. Membership comes from the server-resolved session, never the request.
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { limit = '20', cursor, search } = req.query;

    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 100);

    const houses = await listHouses({
      userId,
      cursor: typeof cursor === 'string' ? cursor : undefined,
      search: typeof search === 'string' && search.trim().length > 0 ? search.trim() : undefined,
      limit: limitNum + 1,
    });

    const hasMore = houses.length > limitNum;
    const housesToReturn = hasMore ? houses.slice(0, limitNum) : houses;
    const nextCursor = hasMore && housesToReturn.length > 0
      ? housesToReturn[housesToReturn.length - 1].id
      : undefined;

    // One batched roster read for the whole page. Serializing each house needs
    // its members — to decide whether this caller may see the roster at all —
    // and a per-house query would be N round trips for one screen.
    const rosters = await findMembersByHouseIds(housesToReturn.map((house) => house.id));

    res.json({
      houses: housesToReturn.map((house) =>
        serializeHouseFor(house, rosters.get(house.id) ?? [], userId)
      ),
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching houses:', { userId: req.user?.id, error: describeErrorSafely(error), query: req.query });
    res.status(500).json({
      message: 'Error fetching houses',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Get house details
 * GET /api/houses/:id
 *
 * A `hidden` house is 404 to a non-member so its existence is never confirmed;
 * a `members` house is readable but without its roster.
 */
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    const found = isLiveEntityId(id) ? await findHouseWithMembers(id) : undefined;

    if (!found || !canSeeHouse(found.house, found.members, userId)) {
      return res.status(404).json({ message: 'House not found' });
    }

    res.json({ house: serializeHouseFor(found.house, found.members, userId) });
  } catch (error) {
    logger.error('Error fetching house:', { userId: req.user?.id, houseId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error fetching house',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Update house (admin/owner only)
 * PATCH /api/houses/:id
 */
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');
    const { name, description, avatar, coverImage, tags, visibility } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const found = isLiveEntityId(id) ? await findHouseWithMembers(id) : undefined;

    if (!found) {
      return res.status(404).json({ message: 'House not found' });
    }

    // Must be admin or owner to update
    if (!hasRole(found.members, userId, HouseMemberRole.ADMIN)) {
      return res.status(403).json({ message: 'Only admins or owner can update the house' });
    }

    /**
     * `null` CLEARS and `undefined` LEAVES ALONE. The Mongoose original assigned
     * `undefined` to clear and `save()` issued `$unset`; drizzle DROPS an
     * `undefined`-valued key, so keeping that spelling would make "remove the
     * avatar" silently keep the old one — the exact defect that shipped twice in
     * earlier verticals.
     */
    const update: Parameters<typeof updateHouse>[1] = {};

    if (name !== undefined && typeof name === 'string' && name.trim().length > 0) {
      update.name = name.trim();
    }
    if (description !== undefined) {
      update.description = description ? String(description).trim() : null;
    }
    if (avatar !== undefined) {
      update.avatar = avatar ? String(avatar).trim() : null;
    }
    if (coverImage !== undefined) {
      update.coverImage = coverImage ? String(coverImage).trim() : null;
    }
    if (tags !== undefined && Array.isArray(tags)) {
      update.tags = tags.map((t: unknown) => String(t).trim()).filter(Boolean);
    }
    if (visibility !== undefined) {
      // Merge onto the house's CURRENT visibility so a partial update touches
      // only the axes it names.
      const resolvedVisibility = resolveVisibility(visibility, visibilityOf(found.house));
      if ('error' in resolvedVisibility) {
        return res.status(400).json({ message: resolvedVisibility.error });
      }
      update.visibility = resolvedVisibility.visibility;
    }

    const house = await updateHouse(found.house.id, update);
    if (!house) {
      return res.status(404).json({ message: 'House not found' });
    }

    logger.info(`House updated: ${id} by ${userId}`);

    res.json({
      message: 'House updated successfully',
      house: serializeHouseFor(house, found.members, userId),
    });
  } catch (error) {
    logger.error('Error updating house:', { userId: req.user?.id, houseId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error updating house',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Delete house (owner only)
 * DELETE /api/houses/:id
 */
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const found = isLiveEntityId(id) ? await findHouseWithMembers(id) : undefined;

    if (!found) {
      return res.status(404).json({ message: 'House not found' });
    }

    // Only the owner can delete the house
    if (!hasRole(found.members, userId, HouseMemberRole.OWNER)) {
      return res.status(403).json({ message: 'Only the owner can delete the house' });
    }

    await deleteHouse(found.house.id);

    logger.info(`House deleted: ${id} by ${userId}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting house:', { userId: req.user?.id, houseId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error deleting house',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Add member (admin/owner only)
 * POST /api/houses/:id/members
 * Body: { userId: string, role?: string }
 */
router.post('/:id/members', async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const id = getParam(req, 'id');
    const { userId: targetUserId, role } = req.body;

    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!targetUserId || typeof targetUserId !== 'string') {
      return res.status(400).json({ message: 'userId is required' });
    }

    const found = isLiveEntityId(id) ? await findHouseWithMembers(id) : undefined;

    if (!found) {
      return res.status(404).json({ message: 'House not found' });
    }

    // Must be admin or owner to add members
    if (!hasRole(found.members, currentUserId, HouseMemberRole.ADMIN)) {
      return res.status(403).json({ message: 'Only admins or owner can add members' });
    }

    // Check if already a member
    if (isMember(found.members, targetUserId)) {
      return res.status(400).json({ message: 'User is already a member' });
    }

    // Validate role (cannot assign owner role)
    const validRoles: HouseMemberRole[] = [HouseMemberRole.MEMBER, HouseMemberRole.HOST, HouseMemberRole.ADMIN];
    const assignedRole: HouseMemberRole = role && validRoles.includes(role as HouseMemberRole)
      ? (role as HouseMemberRole)
      : HouseMemberRole.MEMBER;

    await addHouseMember(found.house.id, targetUserId, assignedRole);

    logger.info(`User ${targetUserId} added to house ${id} as ${assignedRole} by ${currentUserId}`);

    res.json({
      message: 'Member added successfully',
      house: serializeHouseFor(
        found.house,
        await findHouseMembers(found.house.id),
        currentUserId
      ),
    });
  } catch (error) {
    logger.error('Error adding member:', { userId: req.user?.id, houseId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error adding member',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Update member role (admin/owner only, cannot demote owner)
 * PATCH /api/houses/:id/members/:userId
 * Body: { role: string }
 */
router.patch('/:id/members/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const id = getParam(req, 'id');
    const targetUserId = getParam(req, 'userId');
    const { role } = req.body;

    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!role || typeof role !== 'string') {
      return res.status(400).json({ message: 'role is required' });
    }

    const found = isLiveEntityId(id) ? await findHouseWithMembers(id) : undefined;

    if (!found) {
      return res.status(404).json({ message: 'House not found' });
    }

    // Must be admin or owner to update member roles
    if (!hasRole(found.members, currentUserId, HouseMemberRole.ADMIN)) {
      return res.status(403).json({ message: 'Only admins or owner can update member roles' });
    }

    // Find the target member
    const targetMember = findMember(found.members, targetUserId);
    if (!targetMember) {
      return res.status(404).json({ message: 'Member not found' });
    }

    // Cannot demote or change the owner's role
    if (targetMember.role === HouseMemberRole.OWNER) {
      return res.status(403).json({ message: 'Cannot change the owner\'s role' });
    }

    // Cannot assign owner role through this endpoint
    if (role === HouseMemberRole.OWNER) {
      return res.status(400).json({ message: 'Cannot assign owner role through this endpoint' });
    }

    // Validate the new role
    const validRoles: HouseMemberRole[] = [HouseMemberRole.MEMBER, HouseMemberRole.HOST, HouseMemberRole.ADMIN];
    if (!validRoles.includes(role as HouseMemberRole)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    // Non-owners cannot promote to admin
    const currentMemberRole = getMemberRole(found.members, currentUserId);
    if (role === HouseMemberRole.ADMIN && currentMemberRole !== HouseMemberRole.OWNER) {
      return res.status(403).json({ message: 'Only the owner can promote members to admin' });
    }

    await updateHouseMemberRole(found.house.id, targetUserId, role as HouseMemberRole);

    logger.info(`User ${targetUserId} role updated to ${role} in house ${id} by ${currentUserId}`);

    res.json({
      message: 'Member role updated successfully',
      house: serializeHouseFor(
        found.house,
        await findHouseMembers(found.house.id),
        currentUserId
      ),
    });
  } catch (error) {
    logger.error('Error updating member role:', { userId: req.user?.id, houseId: req.params.id, targetUserId: req.params.userId, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error updating member role',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Remove member (admin/owner, or self-leave)
 * DELETE /api/houses/:id/members/:userId
 */
router.delete('/:id/members/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const id = getParam(req, 'id');
    const targetUserId = getParam(req, 'userId');

    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const found = isLiveEntityId(id) ? await findHouseWithMembers(id) : undefined;

    if (!found) {
      return res.status(404).json({ message: 'House not found' });
    }

    const isSelfLeave = currentUserId === targetUserId;

    // If not self-leave, must be admin or owner
    if (!isSelfLeave && !hasRole(found.members, currentUserId, HouseMemberRole.ADMIN)) {
      return res.status(403).json({ message: 'Only admins or owner can remove members' });
    }

    // Find the target member
    const targetMember = findMember(found.members, targetUserId);
    if (!targetMember) {
      return res.status(404).json({ message: 'Member not found' });
    }

    // Cannot remove the owner
    if (targetMember.role === HouseMemberRole.OWNER) {
      return res.status(403).json({ message: 'Cannot remove the owner from the house' });
    }

    // Non-owners cannot remove admins
    if (targetMember.role === HouseMemberRole.ADMIN && !isSelfLeave) {
      const currentRole = getMemberRole(found.members, currentUserId);
      if (currentRole !== HouseMemberRole.OWNER) {
        return res.status(403).json({ message: 'Only the owner can remove admins' });
      }
    }

    await removeHouseMember(found.house.id, targetUserId);

    logger.info(`User ${targetUserId} removed from house ${id} by ${currentUserId}${isSelfLeave ? ' (self-leave)' : ''}`);

    res.json({
      message: isSelfLeave ? 'Left house successfully' : 'Member removed successfully',
    });
  } catch (error) {
    logger.error('Error removing member:', { userId: req.user?.id, houseId: req.params.id, targetUserId: req.params.userId, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error removing member',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Join a house (self-service)
 * POST /api/houses/:id/join
 *
 * Succeeds only when the house's `join` axis is `anyone`. The joining user is
 * resolved from the session, never the body — membership is an identity claim.
 * Checks compose in order: a house the caller cannot see 404s (a `hidden` house
 * is thus never self-joinable by a stranger, who never learns it exists); an
 * already-member gets 400; an `invite`-only house gets 403. The admin-add path
 * (`POST /:id/members`) is unchanged and independent of this.
 */
router.post('/:id/join', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const found = isLiveEntityId(id) ? await findHouseWithMembers(id) : undefined;
    if (!found || !canSeeHouse(found.house, found.members, userId)) {
      return res.status(404).json({ message: 'House not found' });
    }

    if (isMember(found.members, userId)) {
      return res.status(400).json({ message: 'You are already a member' });
    }

    if (!isSelfJoinable(found.house)) {
      return res.status(403).json({ message: 'This house is invite-only' });
    }

    await addHouseMember(found.house.id, userId, HouseMemberRole.MEMBER);

    logger.info(`User ${userId} self-joined house ${id}`);

    res.json({
      message: 'Joined house successfully',
      house: serializeHouseFor(found.house, await findHouseMembers(found.house.id), userId),
    });
  } catch (error) {
    logger.error('Error joining house:', { userId: req.user?.id, houseId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error joining house',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * List rooms belonging to a house (paginated)
 * GET /api/houses/:id/rooms
 */
router.get('/:id/rooms', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');
    const { status, type, limit = '20', cursor } = req.query;

    // Load the house rather than just probing existence: rooms carry titles,
    // hosts and participant ids, so listing them is gated on visibility.
    const found = isLiveEntityId(id) ? await findHouseWithMembers(id) : undefined;
    if (!found || !canSeeHouse(found.house, found.members, userId)) {
      return res.status(404).json({ message: 'House not found' });
    }
    if (!canAccessRooms(found.house, found.members, userId)) {
      return res.status(403).json({ message: 'Only members can view this house\'s rooms' });
    }

    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 100);

    const rooms = await listRooms({
      houseId: id,
      status:
        typeof status === 'string' && Object.values(RoomStatus).includes(status as RoomStatus)
          ? (status as RoomStatus)
          : undefined,
      type:
        typeof type === 'string' && Object.values(RoomType).includes(type as RoomType)
          ? (type as RoomType)
          : undefined,
      cursor: typeof cursor === 'string' ? cursor : undefined,
      limit: limitNum + 1,
    });

    const hasMore = rooms.length > limitNum;
    const roomsToReturn = hasMore ? rooms.slice(0, limitNum) : rooms;
    const nextCursor = hasMore && roomsToReturn.length > 0
      ? roomsToReturn[roomsToReturn.length - 1].id
      : undefined;

    res.json({
      rooms: roomsToReturn.map((room) => stripInternalStreamFields(room)),
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching house rooms:', { userId: req.user?.id, houseId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error fetching house rooms',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * List series belonging to a house
 * GET /api/houses/:id/series
 */
router.get('/:id/series', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    const found = isLiveEntityId(id) ? await findHouseWithMembers(id) : undefined;
    if (!found || !canSeeHouse(found.house, found.members, userId)) {
      return res.status(404).json({ message: 'House not found' });
    }
    if (!canAccessRooms(found.house, found.members, userId)) {
      return res.status(403).json({ message: 'Only members can view this house\'s series' });
    }

    res.json({
      series: await listActiveSeriesForHouse(id),
    });
  } catch (error) {
    logger.error('Error fetching house series:', { userId: req.user?.id, houseId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error fetching house series',
      error: describeErrorSafely(error),
    });
  }
});

// ---------------------------------------------------------------------------
// Media upload endpoints
// ---------------------------------------------------------------------------

/**
 * Upload house avatar
 * POST /api/houses/:id/avatar
 */
router.post('/:id/avatar', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ message: 'No file provided' });

    const found = isLiveEntityId(id) ? await findHouseWithMembers(id) : undefined;
    if (!found) return res.status(404).json({ message: 'House not found' });
    if (!hasRole(found.members, userId, HouseMemberRole.ADMIN)) {
      return res.status(403).json({ message: 'Only admins or owner can update the house' });
    }

    const { buffer, contentType } = await processImage(req.file.buffer, 'avatar');
    const objectKey = getAgoraHouseAvatarKey(id as string);

    // Delete old object if it was on our CDN
    const oldAvatarKey = cdnUrlToKey(found.house.avatar);
    if (oldAvatarKey && oldAvatarKey !== objectKey) {
      deleteObject(oldAvatarKey).catch(() => {});
    }

    const cdnUrl = await uploadObject(objectKey, buffer, contentType, 'public-read');
    await updateHouse(found.house.id, { avatar: cdnUrl });

    res.json({ avatar: cdnUrl });
  } catch (error) {
    logger.error('Error uploading house avatar:', { houseId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({ message: 'Error uploading avatar', error: describeErrorSafely(error) });
  }
});

/**
 * Upload house cover image
 * POST /api/houses/:id/cover
 */
router.post('/:id/cover', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ message: 'No file provided' });

    const found = isLiveEntityId(id) ? await findHouseWithMembers(id) : undefined;
    if (!found) return res.status(404).json({ message: 'House not found' });
    if (!hasRole(found.members, userId, HouseMemberRole.ADMIN)) {
      return res.status(403).json({ message: 'Only admins or owner can update the house' });
    }

    const { buffer, contentType } = await processImage(req.file.buffer, 'cover');
    const objectKey = getAgoraHouseCoverKey(id as string);

    const oldCoverKey = cdnUrlToKey(found.house.coverImage);
    if (oldCoverKey && oldCoverKey !== objectKey) {
      deleteObject(oldCoverKey).catch(() => {});
    }

    const cdnUrl = await uploadObject(objectKey, buffer, contentType, 'public-read');
    await updateHouse(found.house.id, { coverImage: cdnUrl });

    res.json({ coverImage: cdnUrl });
  } catch (error) {
    logger.error('Error uploading house cover:', { houseId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({ message: 'Error uploading cover', error: describeErrorSafely(error) });
  }
});

export default router;
