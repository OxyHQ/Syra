import { S3Client } from '@aws-sdk/client-s3';
import { logger } from '../utils/logger';

/**
 * S3 Client Configuration
 * Creates and exports a configured S3 client instance
 * Supports AWS S3, DigitalOcean Spaces, LocalStack, MinIO, and other S3-compatible services
 * 
 * Following the standard DigitalOcean Spaces pattern with forcePathStyle: false
 */

const AWS_REGION = process.env.AWS_REGION || 'ams3';
const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL;

// Support both Spaces-specific and AWS credential formats
// Priority: SPACES_KEY/SPACES_SECRET (for DigitalOcean) > AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
const ACCESS_KEY_ID = process.env.SPACES_KEY || process.env.AWS_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.SPACES_SECRET || process.env.AWS_SECRET_ACCESS_KEY;

if (!ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
  logger.warn('[S3Config] S3 credentials not found. S3 operations will fail.');
  logger.warn('[S3Config] Please set either SPACES_KEY/SPACES_SECRET or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY');
}

/**
 * Detect if the endpoint is DigitalOcean Spaces
 * DigitalOcean Spaces uses virtual-hosted-style addressing (forcePathStyle: false)
 */
function isDigitalOceanSpaces(endpoint?: string): boolean {
  if (!endpoint) return false;
  return endpoint.includes('digitaloceanspaces.com');
}

// For DigitalOcean Spaces, default to the region-based endpoint if not explicitly set
const endpoint = AWS_ENDPOINT_URL || (isDigitalOceanSpaces(`https://${AWS_REGION}.digitaloceanspaces.com`) 
  ? `https://${AWS_REGION}.digitaloceanspaces.com` 
  : undefined);

const s3ClientConfig: {
  region: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  endpoint?: string;
  forcePathStyle?: boolean;
} = {
  region: AWS_REGION,
  credentials: ACCESS_KEY_ID && SECRET_ACCESS_KEY
    ? {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
      }
    : undefined,
};

// Configure endpoint and addressing style
if (endpoint) {
  s3ClientConfig.endpoint = endpoint;
  
  // DigitalOcean Spaces requires virtual-hosted-style (forcePathStyle: false)
  // LocalStack/MinIO use path-style (forcePathStyle: true)
  const isDO = isDigitalOceanSpaces(endpoint);
  s3ClientConfig.forcePathStyle = !isDO;
  
  if (isDO) {
    logger.info(`[S3Config] Detected DigitalOcean Spaces endpoint: ${endpoint}`);
    logger.info(`[S3Config] Using virtual-hosted-style addressing (forcePathStyle: false)`);
  } else {
    logger.info(`[S3Config] Using custom S3-compatible endpoint: ${endpoint}`);
    logger.info(`[S3Config] Using path-style addressing (forcePathStyle: true)`);
  }
} else {
  // AWS S3 default - no custom endpoint
  logger.info(`[S3Config] Using default AWS S3 endpoints`);
}

export const s3Client = new S3Client(s3ClientConfig);

// Read bucket name from environment variable
// Support both AWS_S3_BUCKET_NAME (documented) and AWS_S3_BUCKET (backwards compatibility)
export const S3_BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME || process.env.AWS_S3_BUCKET || 'syra-audio';
export const S3_AUDIO_PREFIX = process.env.S3_AUDIO_PREFIX || 'audio';

// Export region and endpoint for error messages
export const S3_REGION = AWS_REGION;
export const S3_ENDPOINT = endpoint;

// Log S3 configuration at startup
logger.info('[S3Config] S3 Configuration:', {
  bucket: S3_BUCKET_NAME,
  region: AWS_REGION,
  endpoint: endpoint || 'default (AWS)',
  audioPrefix: S3_AUDIO_PREFIX,
  credentialsConfigured: !!(ACCESS_KEY_ID && SECRET_ACCESS_KEY),
  credentialSource: process.env.SPACES_KEY ? 'SPACES_KEY/SPACES_SECRET' : 'AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY',
  addressingStyle: endpoint 
    ? (isDigitalOceanSpaces(endpoint) ? 'virtual-hosted' : 'path-style')
    : 'default (AWS)',
  forcePathStyle: s3ClientConfig.forcePathStyle ?? (endpoint ? false : undefined),
});

// Log the actual client configuration (sanitized) for debugging
logger.debug('[S3Config] S3Client configuration:', {
  region: s3ClientConfig.region,
  endpoint: s3ClientConfig.endpoint,
  forcePathStyle: s3ClientConfig.forcePathStyle,
  hasCredentials: !!s3ClientConfig.credentials,
  credentialSource: process.env.SPACES_KEY ? 'SPACES_KEY/SPACES_SECRET' : 'AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY',
});

/**
 * Get S3 key for an audio file
 * Format: audio/{artistId}/{albumId}/{trackId}.{format}
 */
export function getS3AudioKey(trackId: string, artistId: string, albumId: string | undefined, format: string): string {
  const extension = format.startsWith('.') ? format : `.${format}`;
  if (albumId) {
    return `${S3_AUDIO_PREFIX}/${artistId}/${albumId}/${trackId}${extension}`;
  }
  return `${S3_AUDIO_PREFIX}/${artistId}/${trackId}${extension}`;
}
