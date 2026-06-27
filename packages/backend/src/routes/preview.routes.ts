import { Router } from 'express';
import { getTrackPreview } from '../controllers/preview.controller';

const router = Router();

// Public 30s preview clip. The `.mp3` suffix is part of the path so the URL is a
// plain, directly-playable audio resource.
router.get('/:trackId.mp3', getTrackPreview);

export default router;
