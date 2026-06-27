import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { TrackModel } from '../models/Track';
import { ArtistModel } from '../models/CatalogEntity';
import { AlbumModel } from '../models/Album';
import { toApiFormat, toApiFormatArray, formatTracksWithCoverArt, formatTrackWithCoverArt } from '../utils/musicHelpers';
import { isDatabaseConnected } from '../utils/database';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId as getAuthenticatedUserId } from '@oxyhq/core/server';
import { uploadTrackAudio } from '../services/audioStorageService';
import { logger } from '../utils/logger';
import { getStoredImageColors } from '../utils/imageColors';
import { enqueueIngest } from '../services/ingest/ingestTrack';
import { getErrorMessage, getErrorStack, getHttpStatus } from '../utils/error';
import { getParam } from '../utils/reqParams';
import {
  getRequestUserId,
  playableTrackFilter,
  resolveCatalogPlaybackOptions,
} from '../utils/catalogVisibility';

interface AudioUploadRequest extends AuthRequest {
  file?: Express.Multer.File;
}

/**
 * GET /api/tracks
 * Get all tracks with pagination
 */
export const getTracks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const playbackOptions = await resolveCatalogPlaybackOptions(getRequestUserId(req as AuthRequest));

    const [tracks, total] = await Promise.all([
      TrackModel.find(playableTrackFilter({}, playbackOptions))
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      TrackModel.countDocuments(playableTrackFilter({}, playbackOptions)),
    ]);

    const formattedTracks = await formatTracksWithCoverArt(tracks);

    res.json({
      tracks: formattedTracks,
      total,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/tracks/:id
 * Get track by ID
 */
export const getTrackById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const id = getParam(req, 'id');
    const playbackOptions = await resolveCatalogPlaybackOptions(getRequestUserId(req as AuthRequest));
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Track not found' });
    }
    
    const track = await TrackModel.findOne(playableTrackFilter({ _id: id }, playbackOptions)).lean();

    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const formattedTrack = await formatTrackWithCoverArt(track);
    res.json(formattedTrack);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/tracks/search
 * Search tracks
 */
export const searchTracks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const query = (req.query.q as string) || '';
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const playbackOptions = await resolveCatalogPlaybackOptions(getRequestUserId(req as AuthRequest));

    if (!query.trim()) {
      return res.json({
        tracks: [],
        total: 0,
        hasMore: false,
      });
    }

    const searchRegex = new RegExp(query, 'i');
    const [tracks, total] = await Promise.all([
      TrackModel.find(
        playableTrackFilter({
          $or: [
            { title: searchRegex },
            { artistName: searchRegex },
          ],
        }, playbackOptions),
      )
        .sort({ popularity: -1, createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      TrackModel.countDocuments(playableTrackFilter({
        $or: [
          { title: searchRegex },
          { artistName: searchRegex },
        ],
      }, playbackOptions)),
    ]);

    const formattedTracks = await formatTracksWithCoverArt(tracks);

    res.json({
      tracks: formattedTracks,
      total,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    next(error);
  }
};

// Configure multer for audio file uploads
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit for audio files
  },
  fileFilter: (req, file, cb) => {
    // Accept audio formats
    const allowedMimes = [
      'audio/mpeg',
      'audio/mp3',
      'audio/mpeg3',
      'audio/x-mpeg-3',
      'audio/flac',
      'audio/ogg',
      'audio/vorbis',
      'audio/mp4',
      'audio/x-m4a',
      'audio/wav',
      'audio/x-wav',
    ];
    
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only audio files (mp3, flac, ogg, m4a, wav) are allowed.'));
    }
  },
}).single('audioFile');

/**
 * POST /api/tracks/upload
 * Upload a new track (authenticated, requires artist profile)
 */
export const uploadTrack = async (req: AuthRequest, res: Response, next: NextFunction) => {
  // Handle file upload
  audioUpload(req, res, async (err) => {
    if (err) {
      logger.error('[TracksController] Multer upload error:', err);
      return res.status(400).json({ error: 'Upload error', message: err.message });
    }

    try {
      logger.debug('[TracksController] Starting track upload process...');
      if (!isDatabaseConnected()) {
        return res.status(503).json({ error: 'Database not available' });
      }

      const userId = getAuthenticatedUserId(req);
      const file = (req as AudioUploadRequest).file;

      if (!file) {
        return res.status(400).json({ error: 'Missing file', message: 'Audio file is required' });
      }

      // Get form data
      const { title, artistId, albumId, coverArt, genre, isExplicit, duration } = req.body;

      if (!title || !artistId) {
        return res.status(400).json({ 
          error: 'Missing required fields', 
          message: 'Title and artistId are required' 
        });
      }

      // Verify user owns the artist
      const artist = await ArtistModel.findOne({ 
        _id: artistId,
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

      // Validate album if provided
      let album = null;
      if (albumId) {
        album = await AlbumModel.findOne({ 
          _id: albumId,
          artistId: artistId 
        }).lean();

        if (!album) {
          return res.status(404).json({ 
            error: 'Album not found', 
            message: 'Album does not exist or does not belong to this artist' 
          });
        }
      }

      // Determine audio format from file
      const formatMap: Record<string, 'mp3' | 'flac' | 'ogg' | 'm4a' | 'wav'> = {
        'audio/mpeg': 'mp3',
        'audio/mp3': 'mp3',
        'audio/mpeg3': 'mp3',
        'audio/x-mpeg-3': 'mp3',
        'audio/flac': 'flac',
        'audio/ogg': 'ogg',
        'audio/vorbis': 'ogg',
        'audio/mp4': 'm4a',
        'audio/x-m4a': 'm4a',
        'audio/wav': 'wav',
        'audio/x-wav': 'wav',
      };

      const format = formatMap[file.mimetype] || 'mp3';
      const durationNum = duration ? parseFloat(duration) : 0;

      if (durationNum <= 0) {
        return res.status(400).json({ 
          error: 'Invalid duration', 
          message: 'Duration must be greater than 0' 
        });
      }

      // Validate coverArt if provided - must be a valid MongoDB ObjectId string
      if (coverArt) {
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

      }

      const coverArtColors = coverArt ? await getStoredImageColors(coverArt) : undefined;

      // Generate track ID first so we can create the audio URL
      const trackId = new mongoose.Types.ObjectId();

      // Create track record with proper audio URL
      const track = new TrackModel({
        _id: trackId,
        title,
        artistId: artistId,
        artistName: artist.name,
        albumId: albumId || undefined,
        albumName: album?.title,
        duration: durationNum,
        audioSource: {
          url: `/api/audio/${trackId.toString()}`,
          format,
        },
        coverArt: coverArt || undefined,
        primaryColor: coverArtColors?.primaryColor,
        secondaryColor: coverArtColors?.secondaryColor,
        metadata: {
          genre: genre ? (Array.isArray(genre) ? genre : [genre]) : undefined,
          explicit: isExplicit === 'true' || isExplicit === true,
        },
        isExplicit: isExplicit === 'true' || isExplicit === true,
        isAvailable: true,
        playCount: 0,
        popularity: 0,
        source: 'upload',
        status: 'processing',
      });

      // Upload audio file to S3 first
      const trackForUpload = toApiFormat(track);
      if (!trackForUpload) {
        throw new Error('Failed to serialize track for upload');
      }
      logger.debug('[TracksController] Starting S3 upload...');
      await uploadTrackAudio(trackForUpload, file.buffer);
      logger.debug('[TracksController] S3 upload completed, saving track to database...');

      // Save track after successful upload
      logger.debug('[TracksController] Attempting to save track to database', { trackId: trackId.toString() });
      const savedTrack = await track.save();
      logger.debug('[TracksController] Track saved to database successfully', { trackId: savedTrack._id.toString() });

      // Update artist stats
      await ArtistModel.updateOne(
        { _id: artistId },
        { $inc: { 'stats.tracks': 1 } }
      );
      logger.debug('[TracksController] Artist stats updated');

      // Update album stats if track is part of album
      if (albumId) {
        await AlbumModel.updateOne(
          { _id: albumId },
          { 
            $inc: { totalTracks: 1, totalDuration: durationNum }
          }
        );
        logger.debug('[TracksController] Album stats updated');
      }

      // Kick off async HLS ingest (non-blocking); status will transition processing→ready|failed
      enqueueIngest(savedTrack._id.toString());

      logger.debug('[TracksController] Formatting response...');
      const finalTrack = await formatTrackWithCoverArt(track);
      logger.debug('[TracksController] Sending response', { trackId: finalTrack?.id });

      // Ensure response is sent
      if (!res.headersSent) {
        res.status(201).json(finalTrack);
      } else {
        logger.warn('[TracksController] Response already sent, cannot send track data');
      }
    } catch (error: unknown) {
      logger.error('[TracksController] Error uploading track:', {
        message: getErrorMessage(error),
        stack: getErrorStack(error),
        name: error instanceof Error ? error.name : 'UnknownError',
      });

      if (!res.headersSent) {
        res.status(getHttpStatus(error)).json({
          error: getErrorMessage(error) || 'Internal Server Error',
          ...(process.env.NODE_ENV === 'development' && { details: getErrorStack(error) }),
        });
      } else {
        logger.error('[TracksController] Error occurred but response already sent');
      }
    }
  });
};
