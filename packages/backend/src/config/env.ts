import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().optional(),

  MONGODB_URI: z.string(),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().default(100),
  MONGODB_MIN_POOL_SIZE: z.coerce.number().default(10),
  MONGODB_READ_PREFERENCE: z.string().default('primary'),

  REDIS_URL: z.string().optional(),
  REDIS_URI: z.string().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().default(0),

  OXY_API_URL: z.string().default('https://api.oxy.so'),
  FRONTEND_URL: z.string().default('https://syra.fm'),
  ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0)
        : [],
    ),

  AWS_REGION: z.string().optional(),
  AWS_ENDPOINT_URL: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),
  AWS_S3_BUCKET_NAME: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_AUDIO_PREFIX: z.string().default('audio'),
  S3_HLS_PREFIX: z.string().default('hls'),

  STREAM_TOKEN_SECRET: z.string().optional(),
  STREAM_KEY_BASE_URL: z.string().default(''),

  PREMIUM_USER_IDS: z.string().optional(),

  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),

  ACRCLOUD_HOST: z.string().optional(),
  ACRCLOUD_ACCESS_KEY: z.string().optional(),
  ACRCLOUD_ACCESS_SECRET: z.string().optional(),

  AUDIUS_API_URL: z.string().optional(),
  AUDIUS_APP_NAME: z.string().optional(),

  JAMENDO_CLIENT_ID: z.string().optional(),
  JAMENDO_API_URL: z.string().optional(),

  PODCAST_INDEX_KEY: z.string().optional(),
  PODCAST_INDEX_SECRET: z.string().optional(),
  PODCAST_BULK_IMPORT_ENABLED: z.string().optional(),

  LRCLIB_API_URL: z.string().optional(),

  KLIPY_APP_KEY: z.string().optional(),

  LINK_PREVIEW_MAX_WIDTH: z.coerce.number().default(200),
  LINK_PREVIEW_MAX_HEIGHT: z.coerce.number().default(150),
  LINK_PREVIEW_JPEG_QUALITY: z.coerce.number().default(80),
  LINK_PREVIEW_PNG_QUALITY: z.coerce.number().default(80),
  LINK_PREVIEW_WEBP_QUALITY: z.coerce.number().default(80),
  LINK_PREVIEW_MAX_FILE_SIZE: z.coerce.number().default(500 * 1024),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
