import { Router } from 'express';
import { getImage } from '../controllers/images.controller';

const router = Router();

router.get('/:id', getImage);

export default router;
