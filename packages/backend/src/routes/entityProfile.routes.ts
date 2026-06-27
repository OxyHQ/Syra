import { Router } from 'express';
import { getEntityProfile } from '../controllers/entityProfile.controller';

const router = Router();

// GET /api/p/:id — unified Artist+Person profile (public / optional auth).
router.get('/:id', getEntityProfile);

export default router;
