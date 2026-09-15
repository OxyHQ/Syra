import { Router, type NextFunction, type Response } from 'express';
import { requireOxyAuth, type OxyAuthRequest } from '@oxy.so/core/server';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { curatedPlaylistSelectionSchema, playlistImportPreviewRequestSchema, playlistImportCommitSchema,
  mixConsentSchema, mixJoinSchema, releasePreferenceSchema, downloadPolicyUpdateSchema } from '@syra/shared-types';
import { withDb } from '../utils/withDb';
import { ListenerAccessError } from '../services/listener/access-error';
import { readCuratedPlaylists, selectCuratedPlaylists } from '../services/listener/curated-playlists';
import { previewPlaylistImport, commitPlaylistImport } from '../services/listener/playlist-import';
import { createTasteMix, joinTasteMix, listTasteMixes, revokeTasteMix } from '../services/listener/taste-mixes';
import { grantDownload, readDownloadPolicy, setDownloadPolicy } from '../services/listener/downloads';
import { readReleasePreference, setReleasePreference } from '../services/listener/release-notifications';

const idSchema = z.string().min(1).max(128);
const router = Router();

async function handle(req: OxyAuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    const username = req.user?.username ?? userId ?? '';
    if (req.method === 'GET' && req.path.startsWith('/artists/')) {
      return res.json(await readCuratedPlaylists(idSchema.parse(req.params.id)));
    }
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method === 'GET' && req.path.startsWith('/tracks/')) {
      return res.json(await readDownloadPolicy(idSchema.parse(req.params.id), userId));
    }
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (req.path.startsWith('/artists/')) {
      return res.json(await selectCuratedPlaylists(idSchema.parse(req.params.id), userId, curatedPlaylistSelectionSchema.parse(req.body).playlistIds));
    }
    if (req.path === '/import/preview') {
      return res.json(await previewPlaylistImport(playlistImportPreviewRequestSchema.parse(req.body).entries));
    }
    if (req.path === '/import') {
      const body = playlistImportCommitSchema.parse(req.body);
      return res.status(201).json(await commitPlaylistImport(userId, username, body.name, body.trackIds, body.requestId));
    }
    if (req.path === '/mixes/join') return res.json(await joinTasteMix(mixJoinSchema.parse(req.body).token, userId, username));
    if (req.path === '/mixes') {
      if (req.method === 'GET') return res.json(await listTasteMixes(userId));
      mixConsentSchema.parse(req.body);
      return res.status(201).json(await createTasteMix(userId, username));
    }
    if (req.path.startsWith('/mixes/')) {
      await revokeTasteMix(idSchema.parse(req.params.id), userId);
      return res.status(204).send();
    }
    if (req.path === '/releases') {
      return res.json(req.method === 'GET' ? await readReleasePreference(userId) : await setReleasePreference(userId, releasePreferenceSchema.parse(req.body).enabled));
    }
    if (req.path.startsWith('/tracks/')) {
      const id = idSchema.parse(req.params.id);
      if (req.method === 'PUT') return res.json(await setDownloadPolicy(id, userId, downloadPolicyUpdateSchema.parse(req.body).allowed));
      return res.json(await grantDownload(id));
    }
    return res.status(404).json({ error: 'Not found' });
  } catch (error) {
    if (error instanceof ListenerAccessError) return res.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid listener request' });
    return next(error);
  }
}

router.get('/artists/:id/playlists', withDb(handle));
router.get('/tracks/:id/download', withDb(handle));
router.use(requireOxyAuth);
// Applied after authentication: a caller cannot move load to arbitrary account ids.
router.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req: OxyAuthRequest) => req.user?.id ?? 'unauthenticated',
  message: { error: 'Too many listener requests. Please wait a minute.' } }));
router.put('/artists/:id/playlists', withDb(handle));
router.post('/import/preview', withDb(handle));
router.post('/import', withDb(handle));
router.get('/mixes', withDb(handle));
router.post('/mixes', withDb(handle));
router.post('/mixes/join', withDb(handle));
router.delete('/mixes/:id', withDb(handle));
router.get('/releases', withDb(handle));
router.put('/releases', withDb(handle));
router.put('/tracks/:id/download', withDb(handle));
router.post('/tracks/:id/download', withDb(handle));
export default router;
