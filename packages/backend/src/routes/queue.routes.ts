import { Router } from 'express';
import {
  getQueueHandler,
  addToQueue,
  removeFromQueue,
  reorderQueueHandler,
  clearQueueHandler,
  setCurrentTrack,
} from '../controllers/queue.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

// All queue routes require authentication
router.use(requireAuth);

router.get('/', getQueueHandler);
router.post('/add', addToQueue);
router.delete('/remove', removeFromQueue);
router.put('/reorder', reorderQueueHandler);
router.delete('/clear', clearQueueHandler);
router.put('/current', setCurrentTrack);

export default router;






