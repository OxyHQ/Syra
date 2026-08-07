import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import os from 'os';
import mongoose from 'mongoose';
import multer from 'multer';
import { TrackModel } from '../models/Track';
import { ArtistModel } from '../models/CatalogEntity';
import { AlbumModel } from '../models/Album';
import { toApiFormat, toApiFormatArray, formatTracksWithCoverArt, formatTrackWithCoverArt } from '../utils/musicHelpers';
import { isDatabaseConnected } from '../utils/database';
import { env } from '../config/env';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId as getAuthenticatedUserId } from '@oxyhq/core/server';
import { uploadTrackAudio } from '../services/audioStorageService';
import { logger } from '../utils/logger';
import { getStoredImageColors } from '../utils/imageColors';
import { enqueueIngest } from '../services/ingest/ingestQueue';
import {
  AUDIO_UPLOAD_REJECTED_MESSAGE,
  MAX_AUDIO_UPLOAD_BYTES,
  audioFormatFor,
  isAllowedAudioMime,
} from '../config/audioUpload';
import { probeAudio } from '../services/ingest/probeAudio';
import type { ProbedAudio } from '../services/ingest/probeAudio';
import { getErrorMessage, getErrorStack, getHttpStatus } from '../utils/error';
import { getParam, parseBoundedLimit, parseOffset } from '../utils/reqParams';
import { findOwnedArtist } from '../utils/catalogOwnership';
import { updateTrackRequestSchema } from '@syra/shared-types';
import {
  getRequestUserId,
  playableTrackFilter,
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

    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);

    const [tracks, total] = await Promise.all([
      TrackModel.find(playableTrackFilter({}))
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      TrackModel.countDocuments(playableTrackFilter({})),
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
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Track not found' });
    }
    
    const track = await TrackModel.findOne(playableTrackFilter({ _id: id })).lean();

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
 * `GET /api/tracks/search` is public and unauthenticated, so `q` is
 * attacker-controlled and must never reach the regex compiler unescaped: a
 * crafted pattern is a ReDoS against a collection scan. `search.controller.ts`
 * and `podcasts.controller.ts` each carry this same helper and use it; this
 * file was the one that did not.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);

    if (!query.trim()) {
      return res.json({
        tracks: [],
        total: 0,
        hasMore: false,
      });
    }

    const searchRegex = new RegExp(escapeRegex(query.trim()), 'i');
    const [tracks, total] = await Promise.all([
      TrackModel.find(
        playableTrackFilter({
          $or: [
            { title: searchRegex },
            { artistName: searchRegex },
          ],
        }),
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
      })),
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

// Configure multer for audio file uploads.
//
// Disk storage, not memory: ffprobe (duration/bitrate), fpcalc (fingerprint) and
// music-metadata (tags) all read a path, and holding a 200MB Buffer per in-flight
// request does not survive consumer upload volume. Multer removes the temp file
// itself when the multipart parse fails (filter rejection, size limit); every
// path AFTER a successful parse is cleaned up in `uploadTrack`'s `finally`.
//
// The cap and the allowlist come from `config/audioUpload` so this controller and
// the listener-upload controller cannot drift on what Syra accepts.
const audioUpload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: {
    fileSize: MAX_AUDIO_UPLOAD_BYTES,
  },
  fileFilter: (req, file, cb) => {
    if (isAllowedAudioMime(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(AUDIO_UPLOAD_REJECTED_MESSAGE));
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

    // Multer has written the upload to a temp file. It must be removed on every
    // exit path below — validation rejection, thrown error, and success alike.
    const tempPath = (req as AudioUploadRequest).file?.path;

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
      const { title, artistId, albumId, coverArt, genre, isExplicit } = req.body;

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
      // Non-null by construction: multer's fileFilter already refused anything
      // not on the allowlist, and both sides read the same table.
      const format = audioFormatFor(file.mimetype) ?? 'mp3';

      // Duration and bitrate come from the file, never from the client. A
      // hand-typed duration was both a bad user experience and unenforceable.
      let probed: ProbedAudio;
      try {
        probed = await probeAudio(file.path);
      } catch (probeError: unknown) {
        logger.warn('[TracksController] ffprobe rejected the uploaded audio', {
          message: getErrorMessage(probeError),
        });
        return res.status(400).json({
          error: 'Unreadable audio',
          message: 'The audio file could not be read. Please upload a valid audio file.',
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
        duration: probed.durationSec,
        audioSource: {
          url: `/api/audio/${trackId.toString()}`,
          format,
          bitrate: probed.bitrateKbps,
          duration: probed.durationSec,
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
      // Streamed from the temp file rather than buffered: the S3 client derives
      // Content-Length from the fs.ReadStream's path, so nothing is held in memory.
      await uploadTrackAudio(trackForUpload, fs.createReadStream(file.path));
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
            $inc: { totalTracks: 1, totalDuration: probed.durationSec }
          }
        );
        logger.debug('[TracksController] Album stats updated');
      }

      // Hand the track to durable ingest; status transitions processing→ready|failed.
      // Awaited so the 201 is only sent once the job is recorded, but it never
      // waits for the transcode itself.
      await enqueueIngest(savedTrack._id.toString());

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
          ...(env.NODE_ENV === 'development' && { details: getErrorStack(error) }),
        });
      } else {
        logger.error('[TracksController] Error occurred but response already sent');
      }
    } finally {
      if (tempPath) {
        // `force` makes an already-removed file a no-op; any other failure is a
        // real disk problem and is logged rather than swallowed.
        await fs.promises.rm(tempPath, { force: true }).catch((rmError: unknown) =>
          logger.warn('[TracksController] Failed to remove upload temp file', {
            tempPath,
            message: getErrorMessage(rmError),
          }),
        );
      }
    }
  });
};

/**
 * PATCH /api/tracks/:id
 * Edit a track you own. Only the fields in `updateTrackRequestSchema` are accepted —
 * the request body is parsed, never spread — so a caller cannot reach `artistId`,
 * `source`, play counts, or the copyright-takedown fields through this endpoint.
 */
export const updateTrack = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getAuthenticatedUserId(req);
    const trackId = getParam(req, 'id');

    if (!mongoose.Types.ObjectId.isValid(trackId)) {
      return res.status(400).json({ error: 'Invalid track id' });
    }

    const parsed = updateTrackRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const track = await TrackModel.findById(trackId);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // Ownership comes from the STORED track's artistId, never from the request body.
    if (!(await findOwnedArtist(track.artistId, userId))) {
      return res.status(403).json({ error: 'Forbidden', message: 'You do not own this track' });
    }

    // A copyright takedown is not a creator-reversible state: editing must not be a way
    // to put a removed track back in the catalog.
    if (track.copyrightRemoved) {
      return res.status(409).json({
        error: 'Track removed',
        message: 'This track was removed for copyright and cannot be edited',
      });
    }

    const updates = parsed.data;

    if (updates.albumId !== undefined) {
      const album = await AlbumModel.findById(updates.albumId).select('artistId').lean();
      if (!album || album.artistId !== track.artistId) {
        return res.status(400).json({
          error: 'Invalid albumId',
          message: 'Album not found or not owned by this artist',
        });
      }
    }

    // Explicit field-by-field assignment — the parsed object is never spread onto the doc.
    if (updates.title !== undefined) track.title = updates.title;
    if (updates.albumId !== undefined) track.albumId = updates.albumId;
    if (updates.trackNumber !== undefined) track.trackNumber = updates.trackNumber;
    if (updates.discNumber !== undefined) track.discNumber = updates.discNumber;
    if (updates.coverArt !== undefined) track.coverArt = updates.coverArt;
    if (updates.isAvailable !== undefined) track.isAvailable = updates.isAvailable;
    if (updates.metadata !== undefined) {
      track.metadata = { ...track.metadata, ...updates.metadata };
    }

    await track.save();

    const formattedTrack = await formatTrackWithCoverArt(track.toObject());
    res.json(formattedTrack);
  } catch (error) {
    next(error);
  }
};
