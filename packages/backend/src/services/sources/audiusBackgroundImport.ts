import type { MusicSourceConnector } from './MusicSourceConnector';
import { AudiusConnector } from './AudiusConnector';
import { upsertArtist } from '../catalog/upsertArtist';
import { upsertTrack } from '../catalog/upsertTrack';
import { logger } from '../../utils/logger';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum gap between Audius imports for the same normalized query (10 min). */
const AUDIUS_IMPORT_TTL_MS = 10 * 60 * 1000;

/** Max Audius tracks fetched per background import pass. */
const AUDIUS_IMPORT_LIMIT = 20;

// ── Throttle map ──────────────────────────────────────────────────────────────

/**
 * Module-level map of normalized query → epoch ms of last completed import.
 * Used to prevent hammering Audius for repeated identical searches.
 */
const lastImportAt = new Map<string, number>();

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

// ── Deps interface ────────────────────────────────────────────────────────────

export interface AudiusImportDeps {
  /** Connector to use; defaults to `new AudiusConnector()`. */
  connector?: MusicSourceConnector;
  /** Clock function; defaults to `Date.now`. Inject for testable throttling. */
  now?: () => number;
}

// ── Core import ───────────────────────────────────────────────────────────────

/**
 * Search Audius for `query` and upsert all returned tracks + artists into the
 * catalog. Tracks are immediately playable (Audius → `status='ready'`,
 * `streamUrl` set by the connector).
 *
 * Throttled per normalized query: if the same query ran within
 * `AUDIUS_IMPORT_TTL_MS`, returns `{ imported: 0, skipped: true }`.
 *
 * Per-track errors are isolated — one bad track does not abort the rest.
 */
export async function runAudiusImport(
  query: string,
  deps: AudiusImportDeps = {},
): Promise<{ imported: number; skipped: boolean }> {
  const { connector = new AudiusConnector(), now = Date.now } = deps;
  const key = normalizeQuery(query);

  const lastRun = lastImportAt.get(key);
  const currentTime = now();
  if (lastRun !== undefined && currentTime - lastRun < AUDIUS_IMPORT_TTL_MS) {
    return { imported: 0, skipped: true };
  }
  lastImportAt.set(key, currentTime);

  const tracks = await connector.search(query, AUDIUS_IMPORT_LIMIT);

  let imported = 0;
  for (const external of tracks) {
    try {
      await upsertArtist(external.artists[0], 'audius');
      await upsertTrack(external, 'audius');
      imported++;
    } catch (err) {
      logger.warn('[audius-import] skipping track due to upsert error', {
        externalId: external.externalId,
        err,
      });
    }
  }

  return { imported, skipped: false };
}

// ── Fire-and-forget entry point ───────────────────────────────────────────────

/**
 * Fire-and-forget wrapper around `runAudiusImport`.
 *
 * - Blank/whitespace-only query: no-op.
 * - Connector errors and upsert failures are caught and logged; the caller
 *   is never affected.
 * - Never throws synchronously or asynchronously.
 */
export function enqueueAudiusImport(query: string, deps?: AudiusImportDeps): void {
  if (!query.trim()) return;

  runAudiusImport(query, deps).catch((err: unknown) => {
    logger.error('[audius-import] failed', { query, err });
  });
}
