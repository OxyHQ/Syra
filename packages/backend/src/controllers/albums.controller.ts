import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { AlbumModel } from '../models/Album';
import { TrackModel } from '../models/Track';
import { ArtistModel } from '../models/Artist';
import { toApiFormat, toApiFormatArray, formatTracksWithCoverArt, formatAlbumWithCoverArt, formatAlbumsWithCoverArt } from '../utils/musicHelpers';
import { isDatabaseConnected } from '../utils/database';
import { AuthRequest } from '../middleware/auth';
import { getAuthenticatedUserId } from '../utils/auth';
import { CreateAlbumRequest } from '@syra/shared-types';
import { extractColorsFromImage } from '../utils/colorHelper';
import { logger } from '../utils/logger';

/**
 * GET /api/albums
 * Get all albums
 */
export const getAlbums = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    const [albums, total] = await Promise.all([
      AlbumModel.find()
        .sort({ releaseDate: -1, createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      AlbumModel.countDocuments(),
    ]);

    const formattedAlbums = formatAlbumsWithCoverArt(albums);

    res.json({
      albums: formattedAlbums,
      total,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/albums/:id
 * Get album by ID
 */
export const getAlbumById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Album not found' });
    }
    
    const album = await AlbumModel.findById(id).lean();

    if (!album) {
      return res.status(404).json({ error: 'Album not found' });
    }

    const formattedAlbum = formatAlbumWithCoverArt(album);
    res.json(formattedAlbum);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/albums/:id/tracks
 * Get tracks in album
 */
export const getAlbumTracks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Album not found' });
    }
    
    // Verify album exists
    const album = await AlbumModel.findById(id).lean();
    if (!album) {
      return res.status(404).json({ error: 'Album not found' });
    }

    // Fetch tracks for this album, sorted by track number
    const tracks = await TrackModel.find({ albumId: id, isAvailable: true })
      .sort({ discNumber: 1, trackNumber: 1 })
      .lean();

    const formattedTracks = await formatTracksWithCoverArt(tracks);

    res.json({
      tracks: formattedTracks,
      albumId: id,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/albums
 * Create a new album (authenticated, requires artist profile)
 */
export const createAlbum = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const data: CreateAlbumRequest = req.body;

    if (!data.title || !data.artistId || !data.releaseDate || !data.coverArt) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        message: 'Title, artistId, releaseDate, and coverArt are required' 
      });
    }

    // Verify user owns the artist
    const artist = await ArtistModel.findOne({ 
      _id: data.artistId,
      ownerOxyUserId: userId 
    }).lean();

    if (!artist) {
      return res.status(403).json({ 
        error: 'Forbidden', 
        message: 'You do not own this artist profile' 
      });
    }

    // Check if uploads are disabled due to strikes
    if (artist.uploadsDisabled) {
      return res.status(403).json({ 
        error: 'Uploads disabled', 
        message: 'Uploads are disabled due to copyright strikes. Please contact support for more information.' 
      });
    }

    // Validate coverArt - must be a valid MongoDB ObjectId string
    if (!data.coverArt) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        message: 'coverArt is required' 
      });
    }

    // Reject blob URLs, http/https URLs, or any other format
    if (data.coverArt.startsWith('blob:') || data.coverArt.startsWith('http://') || data.coverArt.startsWith('https://') || data.coverArt.startsWith('/api/')) {
      return res.status(400).json({ 
        error: 'Invalid coverArt', 
        message: 'coverArt must be a valid image ID (MongoDB ObjectId). Images must be uploaded first using /api/images/upload.' 
      });
    }

    // Validate ObjectId format (24 hex characters)
    if (!mongoose.Types.ObjectId.isValid(data.coverArt)) {
      return res.status(400).json({ 
        error: 'Invalid coverArt', 
        message: 'coverArt must be a valid MongoDB ObjectId string (24 hex characters). Images must be uploaded first using /api/images/upload.' 
      });
    }

    // Extract colors from cover art image
    const imageUrl = `/api/images/${data.coverArt}`;
    const colors = await extractColorsFromImage(undefined, imageUrl);

    // Create album
    const album = new AlbumModel({
      title: data.title,
      artistId: data.artistId,
      artistName: artist.name,
      releaseDate: data.releaseDate,
      coverArt: data.coverArt,
      genre: data.genre || [],
      type: data.type || 'album',
      label: data.label,
      copyright: data.copyright,
      isExplicit: data.isExplicit || false,
      totalTracks: 0,
      totalDuration: 0,
      primaryColor: colors?.primaryColor,
      secondaryColor: colors?.secondaryColor,
      popularity: 0,
    });

    await album.save();

    // Update artist stats
    await ArtistModel.updateOne(
      { _id: data.artistId },
      { $inc: { 'stats.albums': 1 } }
    );

    const formattedAlbum = formatAlbumWithCoverArt(album);
    res.status(201).json(formattedAlbum);
  } catch (error: any) {
    logger.error('[AlbumsController] Error creating album:', error);
    next(error);
  }
};

