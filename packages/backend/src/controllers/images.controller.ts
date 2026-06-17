import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { writeFile, readFile, initGridFS } from '../utils/mongoose-gridfs';
import { isDatabaseConnected } from '../utils/database';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/error';
import { getParam } from '../utils/reqParams';
import { AuthRequest } from '../middleware/auth';
import { extractPredominantColorsFromBuffer } from '../services/colorExtractionService';

/**
 * POST /api/images/upload
 * Upload an image file and return its ID
 * Authenticated endpoint
 */
export const uploadImage = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const file = (req as any).file;

    if (!file) {
      return res.status(400).json({ 
        error: 'Missing file', 
        message: 'Image file is required' 
      });
    }

    // Validate file is an image
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return res.status(400).json({ 
        error: 'Invalid file type', 
        message: 'Only image files are allowed' 
      });
    }

    const extractedColors = await extractPredominantColorsFromBuffer(file.buffer);
    const colors = {
      primaryColor: extractedColors.primary,
      secondaryColor: extractedColors.secondary,
    };

    // Upload to GridFS
    const result = await writeFile(file.buffer, {
      filename: file.originalname || 'image',
      contentType: file.mimetype,
      metadata: {
        uploadedBy: req.user?.id,
        uploadedAt: new Date(),
        primaryColor: colors?.primaryColor,
        secondaryColor: colors?.secondaryColor,
      }
    });

    const imageId = (result as any)._id.toString();

    logger.debug('[ImagesController] Image uploaded successfully', { imageId });

    res.status(201).json({ id: imageId, ...colors });
  } catch (error: unknown) {
    logger.error('[ImagesController] Error uploading image:', error);
    next(error);
  }
};

/**
 * GET /api/images/:id
 * Get image by ID
 * Public endpoint
 */
export const getImage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const id = getParam(req, 'id');

    // Validate ObjectId format (24 hex characters)
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ 
        error: 'Invalid image ID', 
        message: 'Image ID must be a valid MongoDB ObjectId' 
      });
    }

    try {
      // Get image stream from GridFS
      const stream = await readFile(id);

      // Set up error handler
      stream.on('error', (streamError: Error) => {
        const code = (streamError as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || streamError.message.includes('FileNotFound')) {
          logger.debug('[ImagesController] Image not found', { id });
          return res.status(404).json({
            error: 'Image not found',
            message: 'The requested image does not exist'
          });
        }
        logger.error('[ImagesController] Error reading image stream:', streamError);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Internal server error',
            message: 'Failed to read image'
          });
        }
      });

      // Get content type from GridFS metadata
      const bucket = initGridFS();
      if (bucket) {
        const files = await bucket.find({ _id: new mongoose.Types.ObjectId(id) }).toArray();
        if (files.length > 0 && files[0].contentType) {
          res.setHeader('Content-Type', files[0].contentType);
        } else {
          res.setHeader('Content-Type', 'image/jpeg'); // Default
        }
      } else {
        res.setHeader('Content-Type', 'image/jpeg'); // Default
      }

      // Set cache headers
      res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
      res.setHeader('Accept-Ranges', 'bytes');

      // Stream the image
      stream.pipe(res);
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (msg.includes('not found') || code === 'ENOENT') {
        return res.status(404).json({
          error: 'Image not found',
          message: 'The requested image does not exist'
        });
      }
      throw error;
    }
  } catch (error: unknown) {
    logger.error('[ImagesController] Error getting image:', error);
    next(error);
  }
};
