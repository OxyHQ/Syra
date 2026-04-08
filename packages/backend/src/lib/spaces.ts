import { S3Client } from "@aws-sdk/client-s3";

/**
 * DigitalOcean Spaces S3 Client Configuration
 * Creates and exports a configured S3 client instance for DigitalOcean Spaces
 */

const REGION = process.env.AWS_REGION || process.env.SPACES_REGION || 'ams3';
const ENDPOINT = process.env.AWS_ENDPOINT_URL || `https://${REGION}.digitaloceanspaces.com`;
const ACCESS_KEY_ID = process.env.SPACES_KEY || process.env.AWS_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.SPACES_SECRET || process.env.AWS_SECRET_ACCESS_KEY;

export const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  forcePathStyle: false, // DigitalOcean Spaces uses virtual-hosted-style addressing
  credentials: ACCESS_KEY_ID && SECRET_ACCESS_KEY
    ? {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
      }
    : undefined,
});






