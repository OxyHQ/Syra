import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ArtistModel } from '../models/Artist';
import { AlbumModel } from '../models/Album';
import { TrackModel } from '../models/Track';
import { toApiFormat, toApiFormatArray, formatTracksWithCoverArt, formatArtistWithImage, formatArtistsWithImage } from '../utils/musicHelpers';
import { isDatabaseConnected } from '../utils/database';
import { AuthRequest } from '../middleware/auth';
import { getAuthenticatedUserId } from '../utils/auth';
import { CreateArtistRequest, ArtistInsights, ArtistDashboard } from '@syra/shared-types';
import { extractColorsFromImage } from '../utils/colorHelper';

/**
 * GET /api/artists
 * Get all artists
 */
export const getArtists = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    const [artists, total] = await Promise.all([
      ArtistModel.find()
        .sort({ popularity: -1, 'stats.followers': -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      ArtistModel.countDocuments(),
    ]);

    const formattedArtists = formatArtistsWithImage(artists);

    res.json({
      artists: formattedArtists,
      total,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/artists/:id
 * Get artist by ID
 */
export const getArtistById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Artist not found' });
    }
    
    const artist = await ArtistModel.findById(id).lean();

    if (!artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const formattedArtist = formatArtistWithImage(artist);
    res.json(formattedArtist);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/artists/:id/albums
 * Get artist albums
 */
export const getArtistAlbums = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Artist not found' });
    }
    
    // Verify artist exists
    const artist = await ArtistModel.findById(id).lean();
    if (!artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    // Fetch albums for this artist, sorted by release date
    const albums = await AlbumModel.find({ artistId: id })
      .sort({ releaseDate: -1 })
      .lean();

    const formattedAlbums = toApiFormatArray(albums);

    res.json({
      albums: formattedAlbums,
      artistId: id,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/artists/:id/tracks
 * Get artist tracks
 */
export const getArtistTracks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Artist not found' });
    }
    
    // Verify artist exists
    const artist = await ArtistModel.findById(id).lean();
    if (!artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    // Fetch tracks for this artist, sorted by popularity then date
    const [tracks, total] = await Promise.all([
      TrackModel.find({ artistId: id, isAvailable: true })
        .sort({ popularity: -1, createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      TrackModel.countDocuments({ artistId: id, isAvailable: true }),
    ]);

    const formattedTracks = await formatTracksWithCoverArt(tracks);

    res.json({
      tracks: formattedTracks,
      total,
      hasMore: offset + limit < total,
      artistId: id,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/artists/:id/follow
 * Follow artist (requires auth)
 */
export const followArtist = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Mock - just return success
    res.json({
      success: true,
      message: 'Artist followed',
      artistId: id,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/artists/:id/unfollow
 * Unfollow artist (requires auth)
 */
export const unfollowArtist = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Mock - just return success
    res.json({
      success: true,
      message: 'Artist unfollowed',
      artistId: id,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/artists/register
 * Register as an artist (create artist profile)
 */
export const registerAsArtist = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const data: CreateArtistRequest = req.body;

    // Check if user already has an artist profile
    const existingArtist = await ArtistModel.findOne({ ownerOxyUserId: userId }).lean();
    if (existingArtist) {
      return res.status(400).json({ 
        error: 'Already registered',
        message: 'You already have an artist profile',
        artistId: existingArtist._id.toString(),
      });
    }

    // Check if artist name is already taken
    const nameExists = await ArtistModel.findOne({ name: data.name }).lean();
    if (nameExists) {
      return res.status(400).json({ 
        error: 'Name taken',
        message: 'This artist name is already taken',
      });
    }

    // Validate image if provided - must be a valid MongoDB ObjectId string
    let colors;
    if (data.image !== undefined && data.image !== null && data.image !== '') {
      // Reject blob URLs, http/https URLs, or any other format
      if (data.image.startsWith('blob:') || data.image.startsWith('http://') || data.image.startsWith('https://') || data.image.startsWith('/api/')) {
        return res.status(400).json({ 
          error: 'Invalid image', 
          message: 'image must be a valid image ID (MongoDB ObjectId). Images must be uploaded first using /api/images/upload.' 
        });
      }

      // Validate ObjectId format (24 hex characters)
      if (!mongoose.Types.ObjectId.isValid(data.image)) {
        return res.status(400).json({ 
          error: 'Invalid image', 
          message: 'image must be a valid MongoDB ObjectId string (24 hex characters). Images must be uploaded first using /api/images/upload.' 
        });
      }

      // Extract colors from image
      try {
        const imageUrl = `/api/images/${data.image}`;
        colors = await extractColorsFromImage(undefined, imageUrl);
      } catch (error) {
        // Continue without colors if extraction fails
        colors = undefined;
      }
    }

    // Create artist profile
    const artist = new ArtistModel({
      name: data.name,
      bio: data.bio,
      image: data.image,
      genres: data.genres || [],
      verified: false, // Artists start unverified
      ownerOxyUserId: userId,
      primaryColor: colors?.primaryColor,
      secondaryColor: colors?.secondaryColor,
      stats: {
        followers: 0,
        albums: 0,
        tracks: 0,
        totalPlays: 0,
        monthlyListeners: 0,
      },
    });

    await artist.save();

    const formattedArtist = formatArtistWithImage(artist);
    res.status(201).json(formattedArtist);
  } catch (error: any) {
    if (error.code === 11000) {
      // Duplicate key error
      return res.status(400).json({ 
        error: 'Name taken',
        message: 'This artist name is already taken',
      });
    }
    next(error);
  }
};

/**
 * GET /api/artists/me
 * Get current user's artist profile
 */
export const getMyArtistProfile = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);

    const artist = await ArtistModel.findOne({ ownerOxyUserId: userId }).lean();

    if (!artist) {
      return res.status(404).json({ 
        error: 'Artist not found',
        message: 'You do not have an artist profile',
      });
    }

    const formattedArtist = formatArtistWithImage(artist);
    res.json(formattedArtist);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/artists/me/dashboard
 * Get artist dashboard data
 */
export const getArtistDashboard = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);

    // Get artist profile
    const artist = await ArtistModel.findOne({ ownerOxyUserId: userId }).lean();
    if (!artist) {
      return res.status(404).json({ 
        error: 'Not found',
        message: 'You do not have an artist profile',
      });
    }

    const artistId = artist._id.toString();

    // Get tracks and albums
    const [tracks, albums, copyrightRemovedTracks] = await Promise.all([
      TrackModel.find({ artistId }).sort({ createdAt: -1 }).limit(10).lean(),
      AlbumModel.find({ artistId }).sort({ createdAt: -1 }).limit(10).lean(),
      TrackModel.find({ artistId, copyrightRemoved: true })
        .sort({ removedAt: -1 })
        .limit(20)
        .lean(),
    ]);

    // Get counts
    const [totalTracks, totalAlbums] = await Promise.all([
      TrackModel.countDocuments({ artistId }),
      AlbumModel.countDocuments({ artistId }),
    ]);

    const totalPlays = tracks.reduce((sum, track) => sum + (track.playCount || 0), 0);

    const dashboard: ArtistDashboard = {
      artist: formatArtistWithImage(artist),
      totalTracks,
      totalAlbums,
      totalPlays,
      followers: artist.stats.followers || 0,
      strikeCount: artist.strikeCount || 0,
      uploadsDisabled: artist.uploadsDisabled || false,
      recentTracks: tracks.map(track => ({
        id: track._id.toString(),
        title: track.title,
        createdAt: track.createdAt?.toISOString() || new Date().toISOString(),
        playCount: track.playCount || 0,
      })),
      recentAlbums: albums.map(album => ({
        id: album._id.toString(),
        title: album.title,
        createdAt: album.createdAt?.toISOString() || new Date().toISOString(),
        totalTracks: album.totalTracks || 0,
      })),
      copyrightRemovedTracks: copyrightRemovedTracks.map(track => ({
        id: track._id.toString(),
        title: track.title,
        removedAt: track.removedAt?.toISOString() || new Date().toISOString(),
        removedReason: track.removedReason,
      })),
    };

    res.json(dashboard);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/artists/me/insights
 * Get artist insights/analytics
 */
export const getArtistInsights = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const period = (req.query.period as string) || 'alltime';

    // Get artist profile
    const artist = await ArtistModel.findOne({ ownerOxyUserId: userId }).lean();
    if (!artist) {
      return res.status(404).json({ 
        error: 'Not found',
        message: 'You do not have an artist profile',
      });
    }

    const artistId = artist._id.toString();

    // Get all tracks for this artist
    const allTracks = await TrackModel.find({ artistId }).lean();

    // Calculate total plays
    const totalPlays = allTracks.reduce((sum, track) => sum + (track.playCount || 0), 0);

    // Get top tracks by play count
    const topTracks = allTracks
      .map(track => ({
        trackId: track._id.toString(),
        title: track.title,
        playCount: track.playCount || 0,
      }))
      .sort((a, b) => b.playCount - a.playCount)
      .slice(0, 10);

    const insights: ArtistInsights = {
      totalPlays,
      monthlyListeners: artist.stats.monthlyListeners || 0,
      followers: artist.stats.followers || 0,
      topTracks,
      period: period as '7days' | '30days' | 'alltime',
    };

    res.json(insights);
  } catch (error) {
    next(error);
  }
};

