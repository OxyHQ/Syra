import type { Response } from 'express';
import { logger } from '../utils/logger';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { externalTrackSchema, type ExternalTrack } from '@syra/shared-types';
import type { MusicSourceConnector } from '../services/sources/MusicSourceConnector';
import { AudiusConnector } from '../services/sources/AudiusConnector';
import { upsertTrack } from '../services/catalog/upsertTrack';

// ── Constants ────────────────────────────────────────────────────────────────

const SEARCH_LIMIT_MIN = 1;
const SEARCH_LIMIT_MAX = 50;
const SEARCH_LIMIT_DEFAULT = 20;

// ── Validation ────────────────────────────────────────────────────────────────

function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return SEARCH_LIMIT_DEFAULT;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return SEARCH_LIMIT_DEFAULT;
  return Math.min(SEARCH_LIMIT_MAX, Math.max(SEARCH_LIMIT_MIN, parsed));
}

function sanitizeProviderSearchTrack(track: ExternalTrack): Omit<ExternalTrack, 'images' | 'streamUrl'> {
  const { images: _images, streamUrl: _streamUrl, artists, album, ...rest } = track;
  return {
    ...rest,
    artists: artists.map(({ images: _artistImages, ...artist }) => artist),
    album: album
      ? {
        ...album,
        images: undefined,
        tracks: undefined,
      }
      : undefined,
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

interface SourcesControllerDeps {
  connector?: MusicSourceConnector;
}

/**
 * Factory that returns bound controller handlers with injected dependencies.
 * Pass `deps.connector` in tests to avoid real network calls.
 */
export function makeSourcesController(deps: SourcesControllerDeps = {}) {
  const connector: MusicSourceConnector = deps.connector ?? new AudiusConnector();

  /**
   * GET /api/sources/audius/search
   *
   * Public — no auth required for browsing.
   * Query params:
   *   q     {string}  required — search query (400 if missing/empty)
   *   limit {number}  optional — clamped to 1–50, default 20
   *
   * Responses:
   *   200 { results: ExternalTrack[] }
   *   400 { error: string }  — missing/empty q
   *   502 { error: string }  — connector failure (internals masked)
   */
  async function searchAudius(req: AuthRequest, res: Response): Promise<void> {
    const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : undefined;

    if (!q) {
      res.status(400).json({ error: 'Query parameter q is required and must not be empty' });
      return;
    }

    const limit = clampLimit(
      typeof req.query['limit'] === 'string' ? req.query['limit'] : undefined,
    );

    try {
      const results = await connector.search(q, limit);
      res.status(200).json({ results: results.map(sanitizeProviderSearchTrack) });
    } catch (err) {
      logger.error('Audius search failed', err);
      res.status(502).json({ error: 'Audius search failed' });
    }
  }

  /**
   * POST /api/sources/audius/add
   *
   * Auth required — `req.user?.id` must be present.
   * Body: ExternalTrack (provider must be 'audius', externalId + title + artists[0] required).
   *
   * Upserts artist and track into the catalog (Audius tracks are stream-only,
   * status is set to 'ready' immediately — no ingest job needed).
   *
   * Responses:
   *   200 { track, created: boolean }
   *   400 { error: string }  — invalid/missing fields
   *   401 { error: string }  — unauthenticated
   */
  async function addAudiusTrack(req: AuthRequest, res: Response): Promise<void> {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const body = req.body as unknown;

    const parsed = externalTrackSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Request body must be a valid ExternalTrack object' });
      return;
    }

    const external = parsed.data;

    if (external.provider !== 'audius') {
      res.status(400).json({ error: 'provider must be "audius"' });
      return;
    }

    if (!external.externalId) {
      res.status(400).json({ error: 'externalId is required' });
      return;
    }

    if (!external.title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    if (!external.artists.length || !external.artists[0]) {
      res.status(400).json({ error: 'artists must contain at least one entry' });
      return;
    }

    const { track, created } = await upsertTrack(external, 'audius');
    if (!track) {
      res.status(400).json({ error: 'Track and primary artist images are required' });
      return;
    }

    res.status(200).json({ track, created });
  }

  return { searchAudius, addAudiusTrack };
}

// ── Singleton default handlers (for route wiring) ────────────────────────────

const defaultController = makeSourcesController();
export const searchAudius = defaultController.searchAudius;
export const addAudiusTrack = defaultController.addAudiusTrack;
