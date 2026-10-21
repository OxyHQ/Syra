import { Router } from 'express';
import { requireOxyAuth as requireAuth } from '@oxy.so/core/server';
import { createAudioUpload } from '../controllers/audioUploads.controller';

/**
 * Direct audio uploads (`services/uploads/directAudioUpload.ts`). Mounted on the
 * PUBLIC router with optional auth like `/uploads`, so the route says for itself
 * that it needs a session.
 */
const router = Router();

router.post('/', requireAuth, createAudioUpload);

export default router;
