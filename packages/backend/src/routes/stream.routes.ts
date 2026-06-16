import { Router } from 'express';
import {
  getStream,
  getStreamKey,
  getMasterPlaylist,
  getVariantPlaylist,
} from '../controllers/stream.controller';

const router = Router();

/**
 * Stream routes are mounted on the PUBLIC router with `optionalAuth` (server.ts).
 * Each handler self-enforces authorization:
 *   - GET /:trackId               — resolver; requires bearer session (issues tokens)
 *   - GET /:trackId/key           — accepts bearer OR valid ?t= stream token
 *   - GET /:trackId/master.m3u8   — accepts bearer OR valid ?t= stream token
 *   - GET /:trackId/v/:variant    — accepts bearer OR valid ?t= stream token
 *
 * Route ordering: specific fixed-suffix paths are registered before /:trackId so
 * Express does not misroute /key, /master.m3u8, or /v/:variant to the resolver.
 */

// Sub-resource routes (specific paths first)
router.get('/:trackId/key', getStreamKey);
router.get('/:trackId/master.m3u8', getMasterPlaylist);
router.get('/:trackId/v/:variant', getVariantPlaylist);

// Resolver (catch-last)
router.get('/:trackId', getStream);

export default router;
