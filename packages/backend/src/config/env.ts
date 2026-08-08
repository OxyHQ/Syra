import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Local dev default only — ECS injects PORT explicitly (oxy-infra
  // terraform-uswest2/app-services.tf). 4120 is Syra's slot in the
  // per-app port map so several Oxy backends can run side by side.
  PORT: z.coerce.number().default(4120),
  LOG_LEVEL: z.string().optional(),

  // Optional at parse time so `env` stays importable in any context (tests,
  // tooling) without a live DB config. The connection is the real authority:
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
  /**
   * The absolute origin the API answers on, stamped into every URL a client is
   * told to fetch — the HLS master playlist, the variant playlists, the key, and
   * the podcast RSS link.
   *
   * **Empty is the LOCAL-DEV value and it must never reach production.** The
   * empty default leaves those URLs relative, which is right on a dev machine
   * where the app and the API share an origin. In production they do not:
   * `syra.fm` serves the app and `api.syra.fm` serves the API, so a relative
   * `/api/stream/<id>/master.m3u8` resolves against the WEB origin and hls.js is
   * handed the SPA's HTML instead of a manifest — `NotSupportedError: Failed to
   * load because no supported source was found`, with nothing failing on the
   * server and no error in any log.
   *
   * That is exactly what happened: the live task definition never set it, and
   * the outage was one unset variable degrading silently. The refinement below
   * is why it cannot happen again — an unset or relative value now fails at
   * boot, naming the variable, instead of shipping broken playback.
   *
   * A trailing slash is normalised rather than refused: every consumer
   * concatenates `${base}/api/...`, so `https://api.syra.fm/` would yield `//api`
   * — a different URL for no reason anyone intended, and not the class of
   * mistake worth refusing a deployment over.
   */
  STREAM_KEY_BASE_URL: z
    .string()
    .default('')
    .transform((value) => value.trim().replace(/\/+$/, '')),

  PREMIUM_USER_IDS: z.string().optional(),

  // Oxy service-app credentials (OAuth2 client-credentials). Exchanged at
  // `POST /auth/service-token` for a short-lived service JWT used to create
  // notifications server-to-server. Absent in local dev — the notifier then
  // refuses to emit rather than pretending to deliver.
  OXY_SERVICE_API_KEY: z.string().optional(),
  OXY_SERVICE_API_SECRET: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),

  JAMENDO_CLIENT_ID: z.string().optional(),
  JAMENDO_API_URL: z.string().optional(),

  /**
   * AcoustID web-service client key (https://acoustid.org/new-application).
   *
   * Optional, and the absence is a supported mode rather than a misconfiguration:
   * `services/uploads/acoustid.ts` answers `unavailable` without it and every
   * caller carries on with the evidence it already had. Screening is strictly
   * weaker without it — an untagged rip is no longer identified by its audio —
   * so a deploy that wants acoustic identification must set it.
   */
  ACOUSTID_API_KEY: z.string().optional(),

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

  /**
   * CrowdSource participatory moderation is deliberately NOT declared here.
   *
   * `env` is parsed once at import, which is right for every value above and
   * wrong for this one: the enabled flag, the service credential and the webhook
   * secret have to be validated as a UNIT (enabled requires both, or Syra sends
   * reports that can never come back), and that combination has to be
   * re-derivable rather than frozen at first import. `src/moderation/config.ts`
   * owns those reads and the validation that makes them meaningful.
   */
}).superRefine((value, ctx) => {
  /**
   * Production must not boot on a local-dev media origin.
   *
   * Checked here rather than on the field itself because the rule is a RELATION
   * between two values — the variable is legitimately empty in development and
   * in tests, and only `NODE_ENV === 'production'` makes an empty or relative
   * one wrong. A per-field validator cannot express that, which is how it was
   * unset in production for as long as it was.
   *
   * Absolute means an `http:`/`https:` origin, parsed rather than pattern-
   * matched: `//api.syra.fm` and `api.syra.fm` both LOOK addressable and neither
   * survives `${base}/api/...` on a page served from another origin.
   */
  if (value.NODE_ENV !== 'production') return;

  const base = value.STREAM_KEY_BASE_URL;
  const absolute = (() => {
    if (base === '') return false;
    try {
      return ['http:', 'https:'].includes(new URL(base).protocol);
    } catch {
      return false;
    }
  })();

  if (!absolute) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STREAM_KEY_BASE_URL'],
      message:
        `STREAM_KEY_BASE_URL must be an absolute http(s) origin in production, and is ${
          base === '' ? 'unset' : `'${base}'`
        }. It is stamped into every media URL a client fetches — the HLS master ` +
        'playlist, the variant playlists, the key and the podcast RSS link. Left ' +
        'relative, those resolve against the WEB origin (syra.fm) instead of the ' +
        'API origin, so the player is handed the SPA\'s HTML and fails with ' +
        '"NotSupportedError: Failed to load because no supported source was ' +
        'found" — with nothing failing server-side. Set it to https://api.syra.fm ' +
        'on the task definition.',
    });
  }
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
