import { Router } from 'express';
import {
  uploadImage,
  getImage,
} from '../controllers/images.controller';
import { requireAuth } from '../middleware/auth';
import { singleImageUpload } from '../utils/imageUpload';

const router = Router();

// Public routes
router.get('/:id', getImage);

// Authenticated routes
router.post('/upload', requireAuth, singleImageUpload, uploadImage);

export default router;





