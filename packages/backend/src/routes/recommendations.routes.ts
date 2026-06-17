import { Router } from 'express';
import { getMadeForYouHandler } from '../controllers/recommendations.controller';

const router = Router();

// Authenticated routes (mounted behind oxy.auth() at /api/recommendations)
router.get('/made-for-you', getMadeForYouHandler);

export default router;
