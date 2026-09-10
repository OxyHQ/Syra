import { Router } from 'express';
import { requireOxyAuth as requireAuth } from '@oxy.so/core/server';
import { uploadImage } from '../controllers/images.controller';
import { singleImageUpload } from '../utils/imageUpload';

const router = Router();

router.post('/upload', requireAuth, singleImageUpload, uploadImage);

export default router;
