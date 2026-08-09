import { Router } from 'express';
import {
  streamAudio,
  getAudioInfo,
  getAudioUrl,
} from '../controllers/audio.controller';

const router = Router();

// Stream audio file with Range Request support
// Note: Authentication is required (handled by authenticatedApiRouter in server.ts)
// Track id is an opaque `tracks.id`: /api/audio/:trackId
router.get('/:trackId', streamAudio);

// Get audio file metadata
// Note: Authentication is required (handled by authenticatedApiRouter in server.ts)
// Track id is an opaque `tracks.id`: /api/audio/:trackId/info
router.get('/:trackId/info', getAudioInfo);

// Get authenticated audio URL (pre-signed S3 URL)
// Note: Authentication is required (handled by authenticatedApiRouter in server.ts)
// Track id is an opaque `tracks.id`: /api/audio/:trackId/url
// Returns a pre-signed URL that can be used directly by audio players without authentication headers
router.get('/:trackId/url', getAudioUrl);

export default router;

