import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Local dev default only — ECS injects PORT explicitly (oxy-infra
  // terraform-uswest2/app-services.tf). 4120 is Syra's slot in the
  // per-app port map so several Oxy backends can run side by side.
  PORT: z.coerce.number().default(4120),
  LOG_LEVEL: z.string().optional(),

  /**
   * The Postgres connection string — the only database this service opens.
   *
   * Declared here so a malformed one is refused, and REQUIRED IN PRODUCTION by
   * the refinement below rather than by `.url()` alone, for the same reason
   * `STREAM_KEY_BASE_URL` is: the rule is conditional on `NODE_ENV`, and a
   * per-field requirement cannot express that. It would also be wrong — `env` is
   * parsed once at import and 15 modules import it, while the test harness
   * (`src/test/postgres.ts`) resolves `TEST_DATABASE_URL` and assigns
   * `process.env.DATABASE_URL` in `beforeAll`, i.e. AFTER that parse. A hard
   * `z.string().url()` here throws at import in every one of those files.
   * Verified, not assumed: it fails three cases in
   * `env.productionBoot.test.ts` alone, whose child processes spawn with a
   * pristine environment.
   *
   * Nothing reads `env.DATABASE_URL`. `db/postgres.ts` and `db/migrate.ts` read
   * `process.env.DATABASE_URL` LIVE and must keep doing so, because the test
   * harness assigns it after this module was parsed — a frozen read here would
   * hand them the value from boot and send the suite at whatever the developer's
   * own `DATABASE_URL` names. This entry is a boot-time GATE, not an accessor.
   */
  DATABASE_URL: z.string().url().optional(),

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
   * Both rules below are production-only, and for the same reason: each is a
   * RELATION between `NODE_ENV` and another value rather than a property of that
   * value on its own. Empty and unset are legitimate on a developer's machine
   * and in tests; only production makes them wrong. A per-field validator cannot
   * express that, which is how `STREAM_KEY_BASE_URL` stayed unset in production
   * for as long as it did.
   */
  if (value.NODE_ENV !== 'production') return;

  /**
   * Production must not boot without a Postgres to serve from.
   *
   * `DATABASE_URL` reached production unvalidated: it is read live from
   * `process.env` by `db/postgres.ts` and `db/migrate.ts`, and until this it was
   * not declared here at all. `bootServer` catches a failed `connectPostgres()`,
   * logs and CONTINUES — deliberately, so a transient unreachable database
   * degrades to per-request 503s instead of an outage. That is right for a
   * database that is down and wrong for one that was never configured: an unset
   * or malformed value produces a service that boots, reports healthy-ish, and
   * 503s every route for as long as nobody looks. Refusing at boot is what
   * separates the misconfiguration from the outage, and it is the same failure
   * shape — one unset variable degrading silently — that the
   * `STREAM_KEY_BASE_URL` rule below exists for.
   *
   * The scheme is checked, not just the URL shape: `z.string().url()` accepts
   * `mongodb+srv://…` quite happily (verified), and a leftover Mongo connection
   * string in this slot is the one wrong value this cutover could actually
   * produce.
   */
  const databaseUrl = value.DATABASE_URL;
  if (databaseUrl === undefined || !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message:
        `DATABASE_URL must be a postgres:// or postgresql:// connection string in production, and is ${
          databaseUrl === undefined ? 'unset' : `'${databaseUrl.replace(/:\/\/[^@]*@/, '://***@')}'`
        }. Postgres is the only database this service opens; without it every ` +
        'route answers 503 while the process reports itself started. Set it on the ' +
        'task definition from /oxy/syra/DATABASE_URL (it carries ?sslmode=require — ' +
        'the RDS parameter group sets rds.force_ssl = 1).',
    });
  }

  /**
   * Production must not boot on a local-dev media origin.
   *
   * Absolute means an `http:`/`https:` origin, parsed rather than pattern-
   * matched: `//api.syra.fm` and `api.syra.fm` both LOOK addressable and neither
   * survives `${base}/api/...` on a page served from another origin.
   */
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
