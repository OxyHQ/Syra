import { Router } from 'express';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';
import {
  createUpload,
  listUploads,
  listUploadAlbums,
  getUpload,
  updateUpload,
  deleteUpload,
  promoteUpload,
  getUploadStream,
  getUploadStreamKey,
  getUploadMasterPlaylist,
  getUploadVariantPlaylist,
} from '../controllers/uploads.controller';

/**
 * Listener uploads — the private locker.
 *
 * Mounted on the PUBLIC router with optional auth (server.ts) for exactly the
 * reason `stream.routes.ts` is: the HLS sub-resources are fetched by media
 * players that carry a `?t=` stream token in the URL and cannot set an
 * `Authorization` header. Optional auth here does NOT mean optional
 * authorization — every handler self-enforces, and the ones below that need a
 * real session say so with `requireAuth` rather than trusting the mount.
 *
 * Every locker handler resolves its document with `{ _id, ownerOxyUserId }` in
 * ONE query, so a caller who is not the owner gets 404 — the same answer as an id
 * that does not exist, which is what keeps a stranger from probing for one.
 *
 * Route ordering: the fixed `/stream/...` sub-paths are registered before
 * `/:id/stream` and before the bare `/:id`, so Express cannot misroute a manifest
 * request to the resolver or to the document reader.
 */
const router = Router();

// ── Tokenised media (bearer OR `?t=`; the handler enforces ownership) ─────────
router.get('/:id/stream/key', getUploadStreamKey);
router.get('/:id/stream/master.m3u8', getUploadMasterPlaylist);
router.get('/:id/stream/v/:variant', getUploadVariantPlaylist);

// ── Session-only routes ──────────────────────────────────────────────────────
// The resolver MINTS tokens, so it must not accept one as its own credential.
router.get('/:id/stream', requireAuth, getUploadStream);

router.post('/', requireAuth, createUpload);
router.get('/', requireAuth, listUploads);
// Before `/:id`, or Express matches `albums` as an upload id.
router.get('/albums', requireAuth, listUploadAlbums);
router.post('/:id/promote', requireAuth, promoteUpload);
router.get('/:id', requireAuth, getUpload);
router.patch('/:id', requireAuth, updateUpload);
router.delete('/:id', requireAuth, deleteUpload);

export default router;
