/**
 * Audio Controller Helper Functions
 * Shared validation and utility functions for audio endpoints
 */

import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { TrackModel } from '../models/Track';
import { toApiFormat, formatTrackWithCoverArt } from '../utils/musicHelpers';
import { getTrackAudioMetadata } from '../services/audioStorageService';
import { Track } from '@syra/shared-types';

/**
 * Validation result for track operations
 */
export interface TrackValidationResult {
  isValid: boolean;
  statusCode?: number;
  error?: string;
  track?: Track;
}

/**
 * Validate track ID format
 * @param trackId - The track ID to validate
 * @returns Validation result
 */
export function validateTrackId(trackId: string): { isValid: boolean; error?: string } {
  if (!mongoose.Types.ObjectId.isValid(trackId)) {
    return {
      isValid: false,
      error: 'Invalid track ID format',
    };
  }
  return { isValid: true };
}

/**
 * Fetch and validate track from database
 * @param trackId - The track ID to fetch
 * @returns Validation result with track if found
 */
export async function fetchAndValidateTrack(trackId: string): Promise<TrackValidationResult> {
  // Validate ObjectId format
  const idValidation = validateTrackId(trackId);
  if (!idValidation.isValid) {
    return {
      isValid: false,
      statusCode: 400,
      error: idValidation.error,
    };
  }

  // Fetch track from database
  const trackDoc = await TrackModel.findById(trackId).lean();
  if (!trackDoc) {
    return {
      isValid: false,
      statusCode: 404,
      error: 'Track not found',
    };
  }

  const track = await formatTrackWithCoverArt(trackDoc);

  // Check if track is available
  if (!track.isAvailable) {
    return {
      isValid: false,
      statusCode: 403,
      error: 'Track is not available',
    };
  }

  return {
    isValid: true,
    track,
  };
}

/**
 * Validate audio file exists in storage
 * @param track - The track to validate
 * @returns Validation result
 */
export async function validateAudioFileExists(track: Track): Promise<TrackValidationResult> {
  const metadata = await getTrackAudioMetadata(track);
  if (!metadata || !metadata.contentLength) {
    return {
      isValid: false,
      statusCode: 404,
      error: 'Audio file not found in storage',
    };
  }

  return {
    isValid: true,
  };
}

/**
 * Send error response
 * @param res - Express response object
 * @param statusCode - HTTP status code
 * @param error - Error message
 */
export function sendErrorResponse(res: Response, statusCode: number, error: string): void {
  res.status(statusCode).json({ error });
}

