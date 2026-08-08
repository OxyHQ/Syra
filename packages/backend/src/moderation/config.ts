import type {
  CrowdSourceConnectionConfig,
  ModerationEnforcementMode,
} from '@oxyhq/crowdsource-app';
import { logger } from '../utils/logger';

/**
 * Everything this deployment knows about CrowdSource.
 *
 * Read here rather than in `config/env.ts`, which parses every other Syra setting
 * once at import. That is right for the rest and wrong for this one, for two
 * reasons that go together:
 *
 * - The enabled flag, the service credential and the webhook secret only mean
 *   anything TOGETHER. A deployment with a service key and no webhook secret
 *   sends reports that can never come back — cases open, juries decide, and Syra
 *   never learns the outcome, with nothing failing anywhere to say so. Every
 *   later stage sees only its own half, so this is the one place it can be
 *   caught, and a per-field schema cannot express it.
 * - That combination therefore has to be RE-DERIVABLE rather than frozen at first
 *   import, which is what {@link resetCrowdSourceConfig} exists for.
 *
 * There is deliberately no `CROWDSOURCE_APP_ID`, and one must never be added:
 * `applicationId` is read off the service credential by the SDK, which exposes no
 * option through which one could be passed. A variable holding it could only ever
 * disagree with the credential — and a tenant id the caller can choose is not
 * isolation, it is an IDOR.
 */

const ENFORCEMENT_MODES: readonly ModerationEnforcementMode[] = [
  'observe',
  'manual',
  'automatic',
];

const DEFAULT_OUTBOX_BATCH_SIZE = 50;
const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 5_000;
const MIN_OUTBOX_POLL_INTERVAL_MS = 1_000;
const MAX_OUTBOX_BATCH_SIZE = 500;

/**
 * Syra's deployment configuration, which IS the package's connection config.
 *
 * Declared as an extension rather than restated: the package reads `enabled`,
 * the credentials and the mode, and Syra adds nothing to them. Naming its type
 * here is what makes a field renamed upstream a compile error instead of a
 * silently-ignored option.
 */
export interface CrowdSourceConfig extends CrowdSourceConnectionConfig {
  readonly enabled: boolean;
  /** `applicationId:credentialId:secret`, ONE opaque value. Never split here. */
  readonly serviceKey?: string;
  /** Optional; the SDK defaults to the one deployment. */
  readonly baseUrl?: string;
  readonly webhookSecret?: string;
  /** Both are accepted while a secret is being rotated (§10.8). */
  readonly webhookPreviousSecret?: string;
  readonly outboxBatchSize: number;
  readonly outboxPollIntervalMs: number;
  readonly enforcementMode: ModerationEnforcementMode;
}

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * The mode, defaulting to `observe`.
 *
 * An unrecognised value also becomes `observe`. A typo in an environment variable
 * must never be the reason a track leaves the catalog — failing towards the mode
 * that changes nothing is the only safe reading, and it must not stop the service
 * booting either.
 */
function enforcementMode(value: string | undefined): ModerationEnforcementMode {
  const candidate = trimmed(value);
  if (candidate === undefined) return 'observe';
  const match = ENFORCEMENT_MODES.find((mode) => mode === candidate);
  if (match) return match;
  logger.warn(
    '[CrowdSource] unrecognised CROWDSOURCE_ENFORCEMENT_MODE, falling back to observe',
    { value: candidate },
  );
  return 'observe';
}

function readConfig(): CrowdSourceConfig {
  const requested = trimmed(process.env.CROWDSOURCE_ENABLED) === 'true';
  const serviceKey = trimmed(process.env.CROWDSOURCE_SERVICE_KEY);
  const webhookSecret = trimmed(process.env.CROWDSOURCE_WEBHOOK_SECRET);
  const enabled = requested && serviceKey !== undefined && webhookSecret !== undefined;

  if (requested && !enabled) {
    logger.error(
      '[CrowdSource] CROWDSOURCE_ENABLED=true but the integration is half-configured; staying off',
      {
        hasServiceKey: serviceKey !== undefined,
        hasWebhookSecret: webhookSecret !== undefined,
      },
    );
  }

  const baseUrl = trimmed(process.env.CROWDSOURCE_BASE_URL);
  const webhookPreviousSecret = trimmed(process.env.CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS);

  return {
    enabled,
    ...(serviceKey === undefined ? {} : { serviceKey }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(webhookSecret === undefined ? {} : { webhookSecret }),
    ...(webhookPreviousSecret === undefined ? {} : { webhookPreviousSecret }),
    outboxBatchSize: boundedInteger(
      process.env.CROWDSOURCE_OUTBOX_BATCH_SIZE,
      DEFAULT_OUTBOX_BATCH_SIZE,
      1,
      MAX_OUTBOX_BATCH_SIZE,
    ),
    outboxPollIntervalMs: boundedInteger(
      process.env.CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS,
      DEFAULT_OUTBOX_POLL_INTERVAL_MS,
      MIN_OUTBOX_POLL_INTERVAL_MS,
      Number.MAX_SAFE_INTEGER,
    ),
    enforcementMode: enforcementMode(process.env.CROWDSOURCE_ENFORCEMENT_MODE),
  };
}

let cached: CrowdSourceConfig | null = null;

/** The configuration, derived on first use. */
export function crowdSourceConfig(): CrowdSourceConfig {
  cached ??= readConfig();
  return cached;
}

/** Test hook, and the reason the derivation is a function. */
export function resetCrowdSourceConfig(): void {
  cached = null;
}
