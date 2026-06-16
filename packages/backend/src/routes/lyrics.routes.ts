import { Router } from 'express';
import { getLyrics } from '../controllers/lyrics.controller';

const router = Router();

router.get('/:trackId', getLyrics);

export default router;
