import { z } from 'zod';

export const mediaTypeSchema = z.enum(['image', 'video', 'audio', 'gif', 'document']);
export type MediaType = z.infer<typeof mediaTypeSchema>;
export const MediaType = {
  IMAGE: 'image' as const,
  VIDEO: 'video' as const,
  AUDIO: 'audio' as const,
  GIF: 'gif' as const,
  DOCUMENT: 'document' as const,
};

export const mediaStatusSchema = z.enum([
  'uploading',
  'processing',
  'ready',
  'failed',
  'deleted',
]);
export type MediaStatus = z.infer<typeof mediaStatusSchema>;
export const MediaStatus = {
  UPLOADING: 'uploading' as const,
  PROCESSING: 'processing' as const,
  READY: 'ready' as const,
  FAILED: 'failed' as const,
  DELETED: 'deleted' as const,
};

export const mediaDimensionsSchema = z.object({
  width: z.number(),
  height: z.number(),
});
export type MediaDimensions = z.infer<typeof mediaDimensionsSchema>;

export const mediaMetadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  altText: z.string().optional(),
  tags: z.array(z.string()).optional(),
  location: z.string().optional(),
  device: z.string().optional(),
  software: z.string().optional(),
  isSensitive: z.boolean().optional(),
  isNSFW: z.boolean().optional(),
  hasAudio: z.boolean().optional(),
  bitrate: z.number().optional(),
  fps: z.number().optional(),
  codec: z.string().optional(),
});
export type MediaMetadata = z.infer<typeof mediaMetadataSchema>;

export const mediaSchema = z.object({
  id: z.string(),
  _id: z.string().optional(),
  type: mediaTypeSchema,
  status: mediaStatusSchema,
  url: z.string(),
  thumbnailUrl: z.string().optional(),
  previewUrl: z.string().optional(),
  filename: z.string(),
  originalFilename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  dimensions: mediaDimensionsSchema.optional(),
  duration: z.number().optional(),
  metadata: mediaMetadataSchema,
  uploaderOxyUserId: z.string(),
  postId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Media = z.infer<typeof mediaSchema>;

export const imageExifSchema = z.object({
  camera: z.string().optional(),
  lens: z.string().optional(),
  aperture: z.string().optional(),
  shutterSpeed: z.string().optional(),
  iso: z.number().optional(),
  focalLength: z.number().optional(),
  flash: z.boolean().optional(),
  dateTaken: z.string().optional(),
  gps: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
    })
    .optional(),
});
export type ImageExif = z.infer<typeof imageExifSchema>;

export const imageMediaSchema = mediaSchema.extend({
  type: z.literal('image'),
  dimensions: mediaDimensionsSchema,
  exif: imageExifSchema.optional(),
});
export type ImageMedia = z.infer<typeof imageMediaSchema>;

export const videoMetadataSchema = z.object({
  bitrate: z.number(),
  fps: z.number(),
  codec: z.string(),
  hasAudio: z.boolean(),
  audioCodec: z.string().optional(),
  audioBitrate: z.number().optional(),
  resolution: z.string(),
  aspectRatio: z.string(),
});
export type VideoMetadata = z.infer<typeof videoMetadataSchema>;

export const videoMediaSchema = mediaSchema.extend({
  type: z.literal('video'),
  dimensions: mediaDimensionsSchema,
  duration: z.number(),
  thumbnailUrl: z.string(),
  previewUrl: z.string(),
  videoMetadata: videoMetadataSchema,
});
export type VideoMedia = z.infer<typeof videoMediaSchema>;

export const audioMetadataSchema = z.object({
  bitrate: z.number(),
  codec: z.string(),
  sampleRate: z.number(),
  channels: z.number(),
  duration: z.number(),
});
export type AudioMetadata = z.infer<typeof audioMetadataSchema>;

export const audioMediaSchema = mediaSchema.extend({
  type: z.literal('audio'),
  duration: z.number(),
  audioMetadata: audioMetadataSchema,
});
export type AudioMedia = z.infer<typeof audioMediaSchema>;

export const gifMediaSchema = mediaSchema.extend({
  type: z.literal('gif'),
  dimensions: mediaDimensionsSchema,
  duration: z.number(),
  isAnimated: z.boolean(),
});
export type GifMedia = z.infer<typeof gifMediaSchema>;

export const documentMetadataSchema = z.object({
  pageCount: z.number().optional(),
  author: z.string().optional(),
  subject: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  creator: z.string().optional(),
  producer: z.string().optional(),
  creationDate: z.string().optional(),
  modificationDate: z.string().optional(),
});
export type DocumentMetadata = z.infer<typeof documentMetadataSchema>;

export const documentMediaSchema = mediaSchema.extend({
  type: z.literal('document'),
  pageCount: z.number().optional(),
  documentMetadata: documentMetadataSchema,
});
export type DocumentMedia = z.infer<typeof documentMediaSchema>;

export const mediaUploadRequestSchema = z.object({
  file: z.instanceof(File),
  type: mediaTypeSchema,
  metadata: mediaMetadataSchema.partial().optional(),
  postId: z.string().optional(),
});
export type MediaUploadRequest = z.infer<typeof mediaUploadRequestSchema>;

export const mediaUploadResponseSchema = z.object({
  media: mediaSchema,
  uploadUrl: z.string().optional(),
  uploadId: z.string().optional(),
});
export type MediaUploadResponse = z.infer<typeof mediaUploadResponseSchema>;

export const mediaUploadProgressSchema = z.object({
  uploadId: z.string(),
  bytesUploaded: z.number(),
  totalBytes: z.number(),
  percentage: z.number(),
  status: mediaStatusSchema,
});
export type MediaUploadProgress = z.infer<typeof mediaUploadProgressSchema>;

export const mediaFiltersSchema = z.object({
  type: mediaTypeSchema.optional(),
  status: mediaStatusSchema.optional(),
  uploaderOxyUserId: z.string().optional(),
  postId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  isSensitive: z.boolean().optional(),
  hasAudio: z.boolean().optional(),
  minSize: z.number().optional(),
  maxSize: z.number().optional(),
});
export type MediaFilters = z.infer<typeof mediaFiltersSchema>;

export const mediaProcessingJobSchema = z.object({
  id: z.string(),
  mediaId: z.string(),
  type: z.enum(['thumbnail', 'preview', 'transcode', 'optimize']),
  status: z.enum(['pending', 'processing', 'completed', 'failed']),
  progress: z.number(),
  error: z.string().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export type MediaProcessingJob = z.infer<typeof mediaProcessingJobSchema>;

export const mediaUsageSchema = z.object({
  id: z.string(),
  mediaId: z.string(),
  postId: z.string(),
  oxyUserId: z.string(),
  usageType: z.enum(['primary', 'secondary', 'thumbnail']),
  createdAt: z.string(),
});
export type MediaUsage = z.infer<typeof mediaUsageSchema>;

export const mediaStatsSchema = z.object({
  totalUploads: z.number(),
  totalSize: z.number(),
  byType: z.record(mediaTypeSchema, z.number()),
  byStatus: z.record(mediaStatusSchema, z.number()),
  averageFileSize: z.number(),
  mostUsedMedia: z.array(mediaSchema),
});
export type MediaStats = z.infer<typeof mediaStatsSchema>;
