import { Router } from 'express';
import {
  getStream,
  getStreamKey,
  getMasterPlaylist,
  getVariantPlaylist,
} from '../controllers/stream.controller';
import { streamMediaCors } from '../middleware/streamMediaCors';

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
 *
 * The tokenized media endpoints carry `streamMediaCors` so Google Cast (a foreign
 * Origin) can fetch the manifest, variant playlists, and key cross-origin. The
 * `/:trackId` resolver is bearer-authed and deliberately keeps the global,
 * credentialed CORS — never give it the permissive `*`.
 */

// Sub-resource routes (specific paths first) — tokenized media, Cast-reachable.
router.options('/:trackId/key', streamMediaCors);
router.get('/:trackId/key', streamMediaCors, getStreamKey);
router.options('/:trackId/master.m3u8', streamMediaCors);
router.get('/:trackId/master.m3u8', streamMediaCors, getMasterPlaylist);
router.options('/:trackId/v/:variant', streamMediaCors);
router.get('/:trackId/v/:variant', streamMediaCors, getVariantPlaylist);

// Resolver (catch-last) — bearer-authed, keeps credentialed CORS.
router.get('/:trackId', getStream);

export default router;
