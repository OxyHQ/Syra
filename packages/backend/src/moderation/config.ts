import type {
  CrowdSourceConnectionConfig,
  ModerationEnforcementMode,
} from '@crowdsource.you/core/outbox';
import { logger } from '../utils/logger';

import { oxy } from '../oxyClient';

/** Own moderation uses the shared workload identity. The signed decision webhook
 * remains required: delivery without its verified return path is incomplete. */
const ENFORCEMENT_MODES: readonly ModerationEnforcementMode[] = ['observe', 'manual', 'automatic'];

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
  logger.warn('[CrowdSource] unrecognised CROWDSOURCE_ENFORCEMENT_MODE, falling back to observe', {
    value: candidate,
  });
  return 'observe';
}

function readConfig(): CrowdSourceConfig {
  const requested = trimmed(process.env.CROWDSOURCE_ENABLED) === 'true';
  const webhookSecret = trimmed(process.env.CROWDSOURCE_WEBHOOK_SECRET);
  const enabled = requested && webhookSecret !== undefined;

  if (requested && !enabled) {
    logger.error(
      '[CrowdSource] CROWDSOURCE_ENABLED=true but the integration is half-configured; staying off',
      {
        hasWebhookSecret: webhookSecret !== undefined,
      },
    );
  }

  const baseUrl = trimmed(process.env.CROWDSOURCE_BASE_URL);
  const webhookPreviousSecret = trimmed(process.env.CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS);

  return {
    enabled,
    auth: 'oxy-service',
    oxy,
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
