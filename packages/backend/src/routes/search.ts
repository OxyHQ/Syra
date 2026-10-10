import express from 'express';
import { search } from '../controllers/search.controller';

const router = express.Router();

/**
 * GET /api/search
 * Unified search across tracks, albums, artists, and playlists
 */
router.get('/', search);

export default router;
