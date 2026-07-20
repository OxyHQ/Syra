import { Router } from 'express';
import { clearRadio, getRadioPage } from '../controllers/radio.controller';

const router = Router();

/**
 * Radio is mounted on the PUBLIC router with `optionalAuth` (server.ts): a guest
 * gets a station too, capped at a few preview tracks. The handler resolves the
 * listener itself and never requires a bearer.
 */
router.get('/', getRadioPage);
router.delete('/', clearRadio);

export default router;
