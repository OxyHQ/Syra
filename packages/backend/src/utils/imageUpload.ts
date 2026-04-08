import multer from 'multer';

/**
 * Configure multer for image file uploads
 * Accepts common image formats and stores in memory
 */
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit for image files
  },
  fileFilter: (req, file, cb) => {
    // Accept image formats
    const allowedMimes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'image/bmp',
    ];
    
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only image files (jpeg, png, gif, webp, svg, bmp) are allowed.'));
    }
  },
});

/**
 * Single image file upload middleware
 * Use this when expecting a single image file with field name 'image'
 */
export const singleImageUpload = imageUpload.single('image');

/**
 * Single cover art image file upload middleware
 * Use this when expecting a single image file with field name 'coverArt'
 */
export const singleCoverArtUpload = imageUpload.single('coverArt');





