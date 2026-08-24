import { isPostgresConnected } from '../db/postgres';
import { Request, Response, NextFunction } from 'express';
import { isLiveEntityId } from '@oxyhq/db';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/error';
import { getParam } from '../utils/reqParams';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { extractPredominantColorsFromBuffer } from '../services/colorExtractionService';
import { getImageAssetStream, storeImageAsset } from '../services/imageAssetService';
import { describeErrorSafely } from '../utils/error';

interface ImageUploadRequest extends AuthRequest {
  file?: Express.Multer.File;
}

/**
 * POST /api/images/upload
 * Upload an image file and return its ID
 * Authenticated endpoint
 */
export const uploadImage = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const file = (req as ImageUploadRequest).file;

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

    const result = await storeImageAsset({
      buffer: file.buffer,
      filename: file.originalname || 'image',
      contentType: file.mimetype,
      ownerType: 'upload',
      uploadedBy: req.user?.id,
      primaryColor: colors.primaryColor,
      secondaryColor: colors.secondaryColor,
    });

    const imageId = result.id;

    logger.debug('[ImagesController] Image uploaded successfully', { imageId });

    res.status(201).json({ id: imageId, ...colors });
  } catch (error: unknown) {
    logger.error('[ImagesController] Error uploading image:', { error: describeErrorSafely(error) });
    next(error);
  }
};

/**
 * GET /api/images/:id
 * Get image by ID
 * Public endpoint
 *
 * DELIBERATELY UNGATED, including for a private podcast's cover art, and the
 * reasoning is recorded here so the next reader does not have to re-derive it or
 * "fix" it into a per-vertical guard.
 *
 * An `image_assets` row is shared media with no owner of its own: the same asset
 * can be a track's cover, an artist photo and a show's artwork at once, so there
 * is no single parent to ask about it. What makes it unreachable is that its ID
 * is only ever published through a DTO — and every podcast DTO is now gated
 * (`db/podcasts/serialize.ts`), so a private show's cover id never leaves the
 * server for anyone but its owner. The id is a uuid v7, not a guessable
 * sequence.
 *
 * That is protection by unlinkability rather than by authorization, which is the
 * right strength for cover art and would NOT be for anything with real
 * confidentiality. If an image ever carries something more sensitive than
 * artwork, this endpoint needs a real owner check and this comment is the
 * warning that it does not have one.
 */
export const getImage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const id = getParam(req, 'id');

    /**
     * BOTH live id shapes, not the 24-hex one alone.
     *
     * This endpoint SERVES what `uploadImage` above mints, and that id comes
     * from `services/imageAssetService.ts`, which mints a uuid v7. A
     * `mongoose.Types.ObjectId.isValid` guard here therefore 400'd every image
     * uploaded since the cutover — including the `/api/images/<id>` URLs
     * `db/catalog/serialize.ts` puts on every cover art it serialises, so a
     * 201 from the upload endpoint produced a URL this endpoint refused.
     *
     * `playlists.controller` fixed the same guard on the WRITE side (validating
     * a client-supplied `coverArt`); this is the read side of that one id
     * space, and it outlived that fix.
     */
    if (!isLiveEntityId(id)) {
      return res.status(400).json({
        error: 'Invalid image ID',
        message: 'Image ID is not a valid image identifier'
      });
    }

    try {
      const asset = await getImageAssetStream(id);

      if (!asset) {
        return res.status(404).json({
          error: 'Image not found',
          message: 'The requested image does not exist'
        });
      }

      asset.stream.on('error', (streamError: Error) => {
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

      res.setHeader('Content-Type', asset.contentType || 'image/jpeg');
      if (asset.contentLength > 0) {
        res.setHeader('Content-Length', String(asset.contentLength));
      }
      res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
      res.setHeader('Accept-Ranges', 'bytes');

      asset.stream.pipe(res);
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
    logger.error('[ImagesController] Error getting image:', { error: describeErrorSafely(error) });
    next(error);
  }
};
