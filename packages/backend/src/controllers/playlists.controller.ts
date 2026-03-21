import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Playlist, PlaylistVisibility, PlaylistWithTracks } from '@syra/shared-types';
import { PlaylistModel } from '../models/Playlist';
import { PlaylistTrackModel } from '../models/PlaylistTrack';
import { TrackModel } from '../models/Track';
import { extractColorsFromImage } from '../utils/colorHelper';
import { toApiFormat, toApiFormatArray, formatTrackWithCoverArt, formatPlaylistWithCoverArt, formatPlaylistsWithCoverArt } from '../utils/musicHelpers';
import { isDatabaseConnected } from '../utils/database';
import { AuthRequest } from '../middleware/auth';

/**
 * Check if user has permission to edit playlist
 */
async function canEditPlaylist(playlistId: string, userId: string): Promise<boolean> {
  const playlist = await PlaylistModel.findById(playlistId).lean();
  if (!playlist) return false;
  
  // Owner can always edit
  if (playlist.ownerOxyUserId === userId) return true;
  
  // Check if user is a collaborator with editor role
  const collaborator = playlist.collaborators?.find(c => c.oxyUserId === userId);
  return collaborator?.role === 'editor' || collaborator?.role === 'owner';
}

/**
 * Check if user has permission to view playlist
 */
async function canViewPlaylist(playlistId: string, userId?: string): Promise<boolean> {
  const playlist = await PlaylistModel.findById(playlistId).lean();
  if (!playlist) return false;
  
  // Public playlists are viewable by anyone
  if (playlist.isPublic || playlist.visibility === PlaylistVisibility.PUBLIC) return true;
  
  // Private playlists require authentication
  if (!userId) return false;
  
  // Owner can view
  if (playlist.ownerOxyUserId === userId) return true;
  
  // Collaborators can view
  const collaborator = playlist.collaborators?.find(c => c.oxyUserId === userId);
  return !!collaborator;
}

/**
 * Update playlist track count and total duration
 */
async function updatePlaylistStats(playlistId: mongoose.Types.ObjectId) {
  const playlistTracks = await PlaylistTrackModel.find({ playlistId }).sort({ order: 1 }).lean();
  const trackIds = playlistTracks.map(pt => pt.trackId);
  
  const tracks = await TrackModel.find({ _id: { $in: trackIds }, isAvailable: true }).lean();
  const trackMap = new Map(tracks.map(t => [t._id.toString(), t]));
  
  let totalDuration = 0;
  const validTracks = playlistTracks.filter(pt => trackMap.has(pt.trackId));
  
  validTracks.forEach(pt => {
    const track = trackMap.get(pt.trackId);
    if (track) {
      totalDuration += track.duration || 0;
    }
  });
  
  await PlaylistModel.findByIdAndUpdate(playlistId, {
    trackCount: validTracks.length,
    totalDuration,
  });
}

/**
 * GET /api/playlists
 * Get user's playlists (requires auth)
 */
export const getUserPlaylists = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const playlists = await PlaylistModel.find({
      $or: [
        { ownerOxyUserId: userId },
        { 'collaborators.oxyUserId': userId },
      ],
    })
      .sort({ createdAt: -1 })
      .lean();

    const formattedPlaylists = formatPlaylistsWithCoverArt(playlists);

    res.json({
      playlists: formattedPlaylists,
      total: formattedPlaylists.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/playlists/:id
 * Get playlist by ID (public if playlist is public)
 */
export const getPlaylistById = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    const userId = req.user?.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Check view permission
    if (!(await canViewPlaylist(id, userId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const playlist = await PlaylistModel.findById(id).lean();

    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const formattedPlaylist = formatPlaylistWithCoverArt(playlist);
    res.json(formattedPlaylist);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/playlists/:id/tracks
 * Get tracks in playlist
 */
export const getPlaylistTracks = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    const userId = req.user?.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Check view permission
    if (!(await canViewPlaylist(id, userId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Get playlist tracks in order
    const playlistTracks = await PlaylistTrackModel.find({ playlistId: id })
      .sort({ order: 1 })
      .lean();

    // Get track details
    const trackIds = playlistTracks.map(pt => pt.trackId);
    const tracks = await TrackModel.find({ _id: { $in: trackIds }, isAvailable: true }).lean();

    // Create map for quick lookup
    const trackMap = new Map(tracks.map(t => [t._id.toString(), t]));

    // Build ordered tracks array
    const orderedTracks = await Promise.all(
      playlistTracks.map(async (pt) => {
        const track = trackMap.get(pt.trackId);
        if (!track) return null;
        return {
          track: await formatTrackWithCoverArt(track),
          playlistTrack: {
            trackId: pt.trackId,
            addedAt: pt.addedAt,
            addedBy: pt.addedBy,
            order: pt.order,
          },
        };
      })
    );
    const filteredTracks = orderedTracks.filter(Boolean);

    res.json({
      tracks: filteredTracks.map(ot => ot!.track),
      playlistTracks: filteredTracks.map(ot => ot!.playlistTrack),
      total: filteredTracks.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/playlists
 * Create playlist (requires auth)
 */
export const createPlaylist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = req.user?.id;
    const username = (req.user as any)?.username || userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { name, description, coverArt, visibility, isPublic } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Playlist name is required' });
    }

    // Validate coverArt if provided - must be a valid MongoDB ObjectId string
    if (coverArt !== undefined && coverArt !== null) {
      // Reject blob URLs, http/https URLs, or any other format
      if (coverArt.startsWith('blob:') || coverArt.startsWith('http://') || coverArt.startsWith('https://') || coverArt.startsWith('/api/')) {
        return res.status(400).json({ 
          error: 'Invalid coverArt', 
          message: 'coverArt must be a valid image ID (MongoDB ObjectId). Images must be uploaded first using /api/images/upload.' 
        });
      }

      // Validate ObjectId format (24 hex characters)
      if (!mongoose.Types.ObjectId.isValid(coverArt)) {
        return res.status(400).json({ 
          error: 'Invalid coverArt', 
          message: 'coverArt must be a valid MongoDB ObjectId string (24 hex characters). Images must be uploaded first using /api/images/upload.' 
        });
      }

      // Extract colors from cover art image
      let colors;
      try {
        const imageUrl = `/api/images/${coverArt}`;
        colors = await extractColorsFromImage(undefined, imageUrl);
      } catch (error) {
        // Continue without colors if extraction fails
        colors = undefined;
      }
    }

    const newPlaylist = new PlaylistModel({
      name: name.trim(),
      description: description?.trim(),
      ownerOxyUserId: userId,
      ownerUsername: username,
      coverArt: coverArt || undefined,
      visibility: visibility || PlaylistVisibility.PRIVATE,
      isPublic: isPublic || false,
      trackCount: 0,
      totalDuration: 0,
      followers: 0,
      primaryColor: colors?.primaryColor,
      secondaryColor: colors?.secondaryColor,
    });

    await newPlaylist.save();

    const formattedPlaylist = formatPlaylistWithCoverArt(newPlaylist);
    res.status(201).json(formattedPlaylist);
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/playlists/:id
 * Update playlist (requires auth and edit permission)
 */
export const updatePlaylist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Check edit permission
    if (!(await canEditPlaylist(id, userId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { name, description, coverArt, visibility, isPublic } = req.body;

    const updateData: any = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Playlist name cannot be empty' });
      }
      updateData.name = name.trim();
    }
    if (description !== undefined) {
      updateData.description = description?.trim() || undefined;
    }
    if (coverArt !== undefined) {
      // Validate coverArt if provided - must be a valid MongoDB ObjectId string
      if (coverArt !== null && coverArt !== '') {
        // Reject blob URLs, http/https URLs, or any other format
        if (coverArt.startsWith('blob:') || coverArt.startsWith('http://') || coverArt.startsWith('https://') || coverArt.startsWith('/api/')) {
          return res.status(400).json({ 
            error: 'Invalid coverArt', 
            message: 'coverArt must be a valid image ID (MongoDB ObjectId). Images must be uploaded first using /api/images/upload.' 
          });
        }

        // Validate ObjectId format (24 hex characters)
        if (!mongoose.Types.ObjectId.isValid(coverArt)) {
          return res.status(400).json({ 
            error: 'Invalid coverArt', 
            message: 'coverArt must be a valid MongoDB ObjectId string (24 hex characters). Images must be uploaded first using /api/images/upload.' 
          });
        }

        updateData.coverArt = coverArt;
        
        // Extract colors from cover art image
        try {
          const imageUrl = `/api/images/${coverArt}`;
          const colors = await extractColorsFromImage(undefined, imageUrl);
          if (colors) {
            updateData.primaryColor = colors.primaryColor;
            updateData.secondaryColor = colors.secondaryColor;
          }
        } catch (error) {
          // Continue without colors if extraction fails
        }
      } else {
        updateData.coverArt = undefined;
        updateData.primaryColor = undefined;
        updateData.secondaryColor = undefined;
      }
    }
    if (visibility !== undefined) {
      if (!Object.values(PlaylistVisibility).includes(visibility)) {
        return res.status(400).json({ error: 'Invalid visibility value' });
      }
      updateData.visibility = visibility;
    }
    if (isPublic !== undefined) {
      updateData.isPublic = Boolean(isPublic);
    }

    const playlist = await PlaylistModel.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    ).lean();

    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const formattedPlaylist = formatPlaylistWithCoverArt(playlist);
    res.json(formattedPlaylist);
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/playlists/:id
 * Delete playlist (requires auth and owner permission)
 */
export const deletePlaylist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const playlist = await PlaylistModel.findById(id).lean();
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Only owner can delete
    if (playlist.ownerOxyUserId !== userId) {
      return res.status(403).json({ error: 'Only the owner can delete this playlist' });
    }

    // Delete playlist tracks first
    await PlaylistTrackModel.deleteMany({ playlistId: id });
    
    // Delete playlist
    await PlaylistModel.findByIdAndDelete(id);

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/playlists/:id/tracks
 * Add tracks to playlist (requires auth and edit permission)
 */
export const addTracksToPlaylist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Check edit permission
    if (!(await canEditPlaylist(id, userId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { trackIds, position } = req.body;

    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return res.status(400).json({ error: 'trackIds must be a non-empty array' });
    }

    // Validate track IDs
    const validTrackIds = trackIds.filter(tid => mongoose.Types.ObjectId.isValid(tid));
    if (validTrackIds.length === 0) {
      return res.status(400).json({ error: 'No valid track IDs provided' });
    }

    // Verify tracks exist
    const tracks = await TrackModel.find({ _id: { $in: validTrackIds }, isAvailable: true }).lean();
    if (tracks.length === 0) {
      return res.status(404).json({ error: 'No valid tracks found' });
    }

    // Get current playlist tracks to determine insertion position
    const existingTracks = await PlaylistTrackModel.find({ playlistId: id })
      .sort({ order: -1 })
      .limit(1)
      .lean();
    
    const maxOrder = existingTracks.length > 0 ? existingTracks[0].order : -1;
    const insertPosition = position !== undefined ? Number(position) : maxOrder + 1;

    // Check if tracks already exist in playlist
    const existingPlaylistTracks = await PlaylistTrackModel.find({
      playlistId: id,
      trackId: { $in: validTrackIds },
    }).lean();

    const existingTrackIds = new Set(existingPlaylistTracks.map(pt => pt.trackId));
    const newTrackIds = validTrackIds.filter(tid => !existingTrackIds.has(tid));

    if (newTrackIds.length === 0) {
      return res.status(400).json({ error: 'All tracks are already in the playlist' });
    }

    // If inserting at specific position, shift existing tracks
    if (position !== undefined && insertPosition <= maxOrder) {
      await PlaylistTrackModel.updateMany(
        { playlistId: id, order: { $gte: insertPosition } },
        { $inc: { order: newTrackIds.length } }
      );
    }

    // Add new tracks
    const addedAt = new Date().toISOString();
    const playlistTracksToAdd = newTrackIds.map((trackId, index) => ({
      playlistId: id,
      trackId,
      addedAt,
      addedBy: userId,
      order: insertPosition + index,
    }));

    await PlaylistTrackModel.insertMany(playlistTracksToAdd);

    // Update playlist stats
    await updatePlaylistStats(new mongoose.Types.ObjectId(id));

    res.status(201).json({
      added: newTrackIds.length,
      skipped: validTrackIds.length - newTrackIds.length,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/playlists/:id/tracks
 * Remove tracks from playlist (requires auth and edit permission)
 */
export const removeTracksFromPlaylist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Check edit permission
    if (!(await canEditPlaylist(id, userId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { trackIds } = req.body;

    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return res.status(400).json({ error: 'trackIds must be a non-empty array' });
    }

    // Remove tracks
    const result = await PlaylistTrackModel.deleteMany({
      playlistId: id,
      trackId: { $in: trackIds },
    });

    // Reorder remaining tracks
    const remainingTracks = await PlaylistTrackModel.find({ playlistId: id })
      .sort({ order: 1 })
      .lean();

    // Update order to be sequential
    for (let i = 0; i < remainingTracks.length; i++) {
      await PlaylistTrackModel.updateOne(
      { _id: remainingTracks[i]._id },
      { order: i }
      );
    }

    // Update playlist stats
    await updatePlaylistStats(new mongoose.Types.ObjectId(id));

    res.json({
      removed: result.deletedCount,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/playlists/:id/tracks/reorder
 * Reorder tracks in playlist (requires auth and edit permission)
 */
export const reorderPlaylistTracks = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Check edit permission
    if (!(await canEditPlaylist(id, userId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { trackIds } = req.body;

    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return res.status(400).json({ error: 'trackIds must be a non-empty array' });
    }

    // Get all playlist tracks
    const playlistTracks = await PlaylistTrackModel.find({ playlistId: id }).lean();
    const playlistTrackMap = new Map(playlistTracks.map(pt => [pt.trackId, pt]));

    // Validate all track IDs exist in playlist
    const invalidTrackIds = trackIds.filter(tid => !playlistTrackMap.has(tid));
    if (invalidTrackIds.length > 0) {
      return res.status(400).json({ 
        error: 'Some track IDs are not in the playlist',
        invalidTrackIds,
      });
    }

    // Update order for each track
    const updatePromises = trackIds.map((trackId, index) => {
      const playlistTrack = playlistTrackMap.get(trackId);
      if (!playlistTrack) return null;
      
      return PlaylistTrackModel.updateOne(
        { _id: playlistTrack._id },
        { order: index }
      );
    });

    await Promise.all(updatePromises.filter(Boolean));

    res.json({
      reordered: trackIds.length,
    });
  } catch (error) {
    next(error);
  }
};

