/**
 * Audio Controller
 * Handles audio streaming, metadata, and URL generation endpoints
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { streamTrackAudio, getTrackAudioMetadata, getTrackStreamUrl } from '../services/audioStorageService';
import {
  fetchAndValidateTrack,
  validateAudioFileExists,
  sendErrorResponse,
} from './audio.controller.helpers';

/**
 * Parse Range header (e.g., "bytes=0-1023" or "bytes=1024-")
 * @param rangeHeader - The Range header value
 * @param fileSize - Total file size in bytes
 * @returns Parsed range with start and end, or null if invalid
 */
function parseRange(rangeHeader: string, fileSize: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;

  const matches = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!matches) return null;

  const start = parseInt(matches[1], 10);
  const end = matches[2] ? parseInt(matches[2], 10) : fileSize - 1;

  // Validate range
  if (start > end || start < 0 || end >= fileSize) {
    return null;
  }

  return { start, end };
}

/**
 * Setup stream error handler
 * @param stream - The stream to handle errors for
 * @param res - Express response object
 */
function setupStreamErrorHandler(stream: NodeJS.ReadableStream, res: Response): void {
  stream.on('error', (error) => {
    logger.error('[AudioController] Stream error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream error' });
    }
  });
}

/**
 * Stream audio file with Range Request support (Spotify-style)
 * GET /api/audio/:trackId
 * 
 * Supports HTTP Range requests for seeking and progressive loading.
 * Uses MongoDB ObjectId to identify tracks.
 * 
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export const streamAudio = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { trackId } = req.params;
    
    // Validate and fetch track
    const validation = await fetchAndValidateTrack(trackId);
    if (!validation.isValid || !validation.track) {
      return sendErrorResponse(res, validation.statusCode || 400, validation.error || 'Invalid request');
    }

    const track = validation.track;

    // Validate audio file exists
    const fileValidation = await validateAudioFileExists(track);
    if (!fileValidation.isValid) {
      return sendErrorResponse(res, fileValidation.statusCode || 404, fileValidation.error || 'Audio file not found');
    }

    // Get audio metadata
    const metadata = await getTrackAudioMetadata(track);
    if (!metadata || !metadata.contentLength) {
      return sendErrorResponse(res, 404, 'Audio file not found in storage');
    }

    const fileSize = metadata.contentLength;
    const mimeType = metadata.contentType || `audio/${track.audioSource?.format ?? 'mpeg'}`;
    const rangeHeader = req.headers.range;

    // Set common headers
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

    // Handle Range Request (for seeking/streaming)
    if (rangeHeader) {
      const range = parseRange(rangeHeader, fileSize);
      
      if (!range) {
        // Invalid range, return 416 Range Not Satisfiable
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).json({ error: 'Range Not Satisfiable' });
      }

      const { start, end } = range;

      // Stream from S3 with range
      const { stream, contentLength, contentRange } = await streamTrackAudio(track, {
        start,
        end,
      });

      // Set partial content headers
      res.status(206); // Partial Content
      res.setHeader('Content-Length', contentLength);
      if (contentRange) {
        res.setHeader('Content-Range', contentRange);
      } else {
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      }

      // Pipe stream to response
      stream.pipe(res);
      setupStreamErrorHandler(stream, res);
    } else {
      // No range header - send entire file
      const { stream, contentLength } = await streamTrackAudio(track);
      
      res.status(200);
      res.setHeader('Content-Length', contentLength);

      stream.pipe(res);
      setupStreamErrorHandler(stream, res);
    }
  } catch (error) {
    logger.error('[AudioController] Error streaming audio:', error);
    if (!res.headersSent) {
      next(error);
    }
  }
};

/**
 * Get audio file metadata
 * GET /api/audio/:trackId/info
 * 
 * Returns metadata about the audio file including size, MIME type, and modification date.
 * 
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export const getAudioInfo = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { trackId } = req.params;
    
    // Validate and fetch track
    const validation = await fetchAndValidateTrack(trackId);
    if (!validation.isValid || !validation.track) {
      return sendErrorResponse(res, validation.statusCode || 400, validation.error || 'Invalid request');
    }

    const track = validation.track;

    // Get audio metadata from S3
    const metadata = await getTrackAudioMetadata(track);
    if (!metadata) {
      return sendErrorResponse(res, 404, 'Audio file not found in storage');
    }

    res.json({
      trackId: track.id,
      size: metadata.contentLength,
      mimeType: metadata.contentType || `audio/${track.audioSource?.format ?? 'mpeg'}`,
      lastModified: metadata.lastModified?.toISOString(),
      etag: metadata.etag,
    });
  } catch (error) {
    logger.error('[AudioController] Error getting audio info:', error);
    next(error);
  }
};

/**
 * Get authenticated audio URL (pre-signed S3 URL)
 * GET /api/audio/:trackId/url
 * 
 * Returns a pre-signed URL that can be used directly by audio players
 * without authentication headers. The URL is valid for 1 hour.
 * 
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export const getAudioUrl = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { trackId } = req.params;
    
    // Validate and fetch track
    const validation = await fetchAndValidateTrack(trackId);
    if (!validation.isValid || !validation.track) {
      return sendErrorResponse(res, validation.statusCode || 400, validation.error || 'Invalid request');
    }

    const track = validation.track;

    // Verify audio file exists in S3
    const fileValidation = await validateAudioFileExists(track);
    if (!fileValidation.isValid) {
      return sendErrorResponse(res, fileValidation.statusCode || 404, fileValidation.error || 'Audio file not found');
    }

    // Get pre-signed S3 URL (valid for 1 hour)
    const presignedUrl = await getTrackStreamUrl(track);

    res.json({
      url: presignedUrl,
      trackId: track.id,
      expiresIn: 3600, // 1 hour in seconds
    });
  } catch (error) {
    logger.error('[AudioController] Error getting audio URL:', error);
    next(error);
  }
};
