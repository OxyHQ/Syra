import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client, S3_BUCKET_NAME, S3_REGION, S3_ENDPOINT } from '../config/s3.config';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/error';
import { Readable } from 'stream';

interface AwsSdkError {
    name: string;
    message: string;
    Code?: string;
    HostId?: string;
    BucketName?: string;
    $metadata?: {
        httpStatusCode?: number;
        requestId?: string;
        extendedRequestId?: string;
    };
}

function asAwsError(error: unknown): AwsSdkError {
    if (error !== null && typeof error === 'object') {
        return error as AwsSdkError;
    }
    return { name: 'UnknownError', message: String(error) };
}

/**
 * S3 Service
 * Handles all S3 operations for audio files
 */

export interface S3UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface S3StreamOptions {
  start?: number;
  end?: number;
}

/**
 * Upload a file to S3
 */
export async function uploadToS3(
  key: string,
  body: Buffer | Readable | string,
  options: S3UploadOptions = {}
): Promise<void> {
  try {
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: options.contentType,
      Metadata: options.metadata,
    });

    logger.debug(`[S3Service] Uploading to S3:`, {
      bucket: S3_BUCKET_NAME,
      key,
      region: S3_REGION,
      endpoint: S3_ENDPOINT || 'default (AWS)',
      contentType: options.contentType,
    });

    await s3Client.send(command);
    logger.debug(`[S3Service] Uploaded file to S3: ${key}`);
  } catch (error: unknown) {
    const e = asAwsError(error);
    const errorDetails = {
      key,
      bucket: S3_BUCKET_NAME,
      region: S3_REGION,
      endpoint: S3_ENDPOINT || 'default (AWS)',
      errorCode: e.Code ?? e.name,
      errorMessage: e.message,
      httpStatusCode: e.$metadata?.httpStatusCode,
      requestId: e.$metadata?.requestId,
      hostId: e.HostId ?? e.$metadata?.extendedRequestId,
      errorBucketName: e.BucketName,
    };
    logger.error(`[S3Service] Error uploading to S3:`, errorDetails, error);
    throw error;
  }
}

/**
 * Get a pre-signed URL for reading from S3
 * Expires after 1 hour by default
 */
export async function getPresignedUrl(
  key: string,
  expiresIn: number = 3600
): Promise<string> {
  try {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn });
    logger.debug(`[S3Service] Generated pre-signed URL for: ${key}`);
    return url;
  } catch (error: unknown) {
    const e = asAwsError(error);
    const errorDetails = {
      key,
      bucket: S3_BUCKET_NAME,
      region: S3_REGION,
      endpoint: S3_ENDPOINT || 'default (AWS)',
      errorCode: e.Code ?? e.name,
      errorMessage: e.message,
    };
    logger.error(`[S3Service] Error generating pre-signed URL:`, errorDetails, error);
    throw error;
  }
}

/**
 * Get object metadata from S3
 */
export async function getObjectMetadata(key: string): Promise<{
  contentLength?: number;
  contentType?: string;
  lastModified?: Date;
  etag?: string;
} | null> {
  try {
    const command = new HeadObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
    });

    const response = await s3Client.send(command);
    return {
      contentLength: response.ContentLength,
      contentType: response.ContentType,
      lastModified: response.LastModified,
      etag: response.ETag,
    };
  } catch (error: unknown) {
    const e = asAwsError(error);
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
      return null;
    }
    const errorDetails = {
      key,
      bucket: S3_BUCKET_NAME,
      region: S3_REGION,
      endpoint: S3_ENDPOINT || 'default (AWS)',
      errorCode: e.Code ?? e.name,
      errorMessage: e.message,
    };
    logger.error(`[S3Service] Error getting object metadata:`, errorDetails, error);
    throw error;
  }
}

/**
 * Stream an object from S3 with optional range support
 */
export async function streamFromS3(
  key: string,
  options: S3StreamOptions = {}
): Promise<{
  stream: Readable;
  contentLength: number;
  contentType?: string;
  contentRange?: string;
}> {
  try {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
      Range: options.start !== undefined && options.end !== undefined
        ? `bytes=${options.start}-${options.end}`
        : undefined,
    });

    const response = await s3Client.send(command);
    
    if (!response.Body) {
      throw new Error('No body in S3 response');
    }

    const stream = response.Body as Readable;
    const contentLength = response.ContentLength || 0;
    const contentType = response.ContentType;
    const contentRange = response.ContentRange;

    return {
      stream,
      contentLength,
      contentType,
      contentRange,
    };
  } catch (error: unknown) {
    const e = asAwsError(error);
    const errorDetails = {
      key,
      bucket: S3_BUCKET_NAME,
      region: S3_REGION,
      endpoint: S3_ENDPOINT || 'default (AWS)',
      errorCode: e.Code ?? e.name,
      errorMessage: e.message,
    };
    logger.error(`[S3Service] Error streaming from S3:`, errorDetails, error);
    throw error;
  }
}

/**
 * Delete an object from S3
 */
export async function deleteFromS3(key: string): Promise<void> {
  try {
    const command = new DeleteObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
    });

    await s3Client.send(command);
    logger.debug(`[S3Service] Deleted file from S3: ${key}`);
  } catch (error: unknown) {
    const e = asAwsError(error);
    const errorDetails = {
      key,
      bucket: S3_BUCKET_NAME,
      region: S3_REGION,
      endpoint: S3_ENDPOINT || 'default (AWS)',
      errorCode: e.Code ?? e.name,
      errorMessage: e.message,
    };
    logger.error(`[S3Service] Error deleting from S3:`, errorDetails, error);
    throw error;
  }
}

/**
 * Check if an object exists in S3
 */
export async function objectExists(key: string): Promise<boolean> {
  try {
    const metadata = await getObjectMetadata(key);
    return metadata !== null;
  } catch (error) {
    return false;
  }
}

