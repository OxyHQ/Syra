/**
 * Pacing for the copy-to-Oxy migrations: keep a one-shot inside Oxy's
 * per-application write budgets, and wait out a 429 instead of failing on it.
 *
 * Oxy meters an application's file writes per minute, per lane:
 *
 * - `app` — `POST /assets/service/app` (an upload) and `/app/import` and
 *   `/app/import/batch` (an import, one call for up to 50 URLs), together 30 a
 *   minute;
 * - `user_media` — `POST /assets/service/user-media` (and its import), 30 a
 *   minute, counted apart.
 *
 * The SAME `app` budget serves Syra's live catalogue mirroring
 * (`catalogImageAssets.ts` imports every new artwork), so a migration that spent
 * all 30 would make every live import answer 429 for as long as it ran. A
 * migration therefore takes {@link MIGRATION_CALLS_PER_MINUTE} and leaves the
 * rest to live traffic; whatever 429 it still meets — live traffic spiking, a
 * second instance — is waited out for as long as Oxy says and the SAME call is
 * made again, so a run resumes where it was rather than reporting the rest of
 * its units `failed`.
 */

export type OxyWriteLane = 'app' | 'user_media';

/** Calls per minute a migration makes in one lane: two thirds of Oxy's 30. */
export const MIGRATION_CALLS_PER_MINUTE = 20;

/** How many 429s in a row one call waits out before it is reported as failed. */
const MAX_RATE_LIMITED_ATTEMPTS = 30;

/** The wait when a 429 names none: Oxy's window. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

export interface WritePacerOptions {
  callsPerMinute?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * How long a 429 asks to wait: the API envelope's `details.retryAfterSeconds`,
 * else the `Retry-After` header, else Oxy's one-minute window.
 */
export function retryAfterMs(error: unknown): number {
  const record = error as {
    details?: { retryAfterSeconds?: unknown };
    response?: { headers?: unknown };
  } | null;
  const fromBody = Number(record?.details?.retryAfterSeconds);
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody * 1000;
  const headers = record?.response?.headers;
  const header =
    headers instanceof Headers
      ? headers.get('retry-after')
      : (headers as Record<string, unknown> | undefined)?.['retry-after'];
  const fromHeader = Number(header);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader * 1000;
  return DEFAULT_RETRY_AFTER_MS;
}

export class OxyWritePacer {
  private readonly spacingMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** The earliest moment the next call in each lane may start. */
  private readonly nextSlot = new Map<OxyWriteLane, number>();

  constructor(options: WritePacerOptions = {}) {
    this.spacingMs = 60_000 / (options.callsPerMinute ?? MIGRATION_CALLS_PER_MINUTE);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /**
   * Reserve the lane's next start time and wait for it. The reservation is
   * synchronous, so concurrent workers each get a slot of their own.
   */
  private async slot(lane: OxyWriteLane): Promise<void> {
    const now = this.now();
    const start = Math.max(now, this.nextSlot.get(lane) ?? now);
    this.nextSlot.set(lane, start + this.spacingMs);
    if (start > now) await this.sleep(start - now);
  }

  /** Hold every worker in the lane until `until`: one 429 means the whole lane is spent. */
  private pause(lane: OxyWriteLane, until: number): void {
    this.nextSlot.set(lane, Math.max(this.nextSlot.get(lane) ?? 0, until));
  }

  /** Make one Oxy write in `lane`, paced, and made again after each 429. */
  async call<T>(lane: OxyWriteLane, run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      await this.slot(lane);
      try {
        return await run();
      } catch (error) {
        if (errorStatus(error) !== 429 || attempt >= MAX_RATE_LIMITED_ATTEMPTS) throw error;
        const wait = retryAfterMs(error);
        this.pause(lane, this.now() + wait);
      }
    }
  }
}
