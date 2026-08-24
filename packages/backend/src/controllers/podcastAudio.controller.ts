/**
 * Podcast episode audio: the hybrid external proxy (Phase 3) and the tokenized
 * HLS stream for Syra-hosted episodes (Phase 5).
 *
 * `/audio` is the public progressive-download endpoint:
 *   - rss + cached  → range-served from S3
 *   - rss + origin  → SSRF-safe range-aware reverse proxy of the enclosure
 *   - syra          → range-served from S3 (the creator's original upload; this
 *                     is the enclosure exposed in the generated public RSS)
 *
 * The encrypted HLS path (`/stream`, `/master.m3u8`, `/v/:variant`, `/key`) is
 * for Syra-hosted episodes and REUSES the shared stream primitives
 * (`resolveEpisodeAccess`, `mintStreamToken`, `buildMasterPlaylistFor`,
 * `buildVariantPlaylistFor`) and the `TrackKey` store keyed by the episode id —
 * no duplication of token/key logic.
 *
 * ## Every handler here loads the SHOW, and that is the access control
 *
 * `findEpisodeById` returns `{ episode, show }`, because who may reach an
 * episode's media is decided entirely by its show — its audience, its publish
 * state, its owner. `/key` in particular loaded NO row of any kind before this:
 * it resolved a bitrate cap, read `track_keys` by episode id and handed the
 * AES-128 content key to any signed-in caller for any id, which is the whole
 * encryption defeated by one unauthenticated-in-substance request.
 */

import type { Response } from 'express';
import { Readable } from 'stream';
import { eq } from 'drizzle-orm';
import { isLiveEntityId } from '@oxyhq/db';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { safeFetch, SsrfRejection } from '@oxyhq/core/server';
import { getDb } from '../db/postgres';
import { trackKeys } from '../db/schema/trackKeys';
import { findEpisodeById } from '../db/podcasts/episodes';
import { loadEpisodeHls } from '../db/podcasts/hydrate';
import type { EpisodeRow } from '../db/podcasts/serialize';
import { env } from '../config/env';
import { getS3PodcastEpisodeAudioKey } from '../config/s3.config';
import { streamFromS3, getObjectMetadata } from '../services/s3Service';
import { requestMayReachShowMedia, resolveEpisodeAccess } from './stream.controller';
import { mintStreamToken } from '../services/stream/streamToken';
import { buildMasterPlaylistFor, buildVariantPlaylistFor } from '../services/stream/manifestService';
import { maybeCacheEpisode } from '../services/podcasts/podcastCache';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

const CONTENT_TYPE_OCTET_STREAM = 'application/octet-stream';
const CONTENT_TYPE_HLS_PLAYLIST = 'application/vnd.apple.mpegurl';
const CACHE_CONTROL_NO_STORE = 'no-store';
const CACHE_CONTROL_PLAYLIST = 'private, max-age=300, stale-while-revalidate=1800';
const CACHE_CONTROL_AUDIO = 'public, max-age=3600';
const STREAM_SESSION_TTL_SEC = 3600;

// ── Shared guards ──────────────────────────────────────────────────────────────

function getEpisodeIdParam(req: AuthRequest): string | undefined {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  // `isLiveEntityId`, not `ObjectId.isValid`: this schema stores both a 24-char
  // ObjectId hex (pre-cutover rows) and a uuid v7 (everything since), and the
  // ObjectId-only test rejected every episode created after the cutover.
  return raw && isLiveEntityId(raw) ? raw : undefined;
}

function isEpisodePlayable(episode: { status: string }): boolean {
  return episode.status !== 'unavailable';
}

/**
 * The HLS ladder of one episode.
 *
 * `Episode.hls` was an embedded array; it is `episode_hls_renditions` now, so
 * every HLS handler below loads it explicitly. Kept as its own read rather than
 * folded into `findEpisodeById`, because `/audio` — the busiest of the five
 * endpoints — never needs it.
 */
async function episodeHls(episodeId: string) {
  return (await loadEpisodeHls([episodeId])).get(episodeId) ?? [];
}

interface ParsedRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `bytes=start-end` header against a known total size.
 * Exported for unit testing. Supports `a-b`, `a-` (open end), and `-suffix`;
 * returns null for malformed/unsatisfiable ranges.
 */
export function parseRange(header: string | undefined, totalSize: number): ParsedRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const startRaw = match[1];
  const endRaw = match[2];
  if (startRaw === '' && endRaw === '') return null;

  let start: number;
  let end: number;
  if (startRaw === '') {
    // Suffix range: last N bytes.
    const suffix = parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = parseInt(startRaw, 10);
    end = endRaw === '' ? totalSize - 1 : parseInt(endRaw, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= totalSize) return null;
  return { start, end: Math.min(end, totalSize - 1) };
}

// ── /audio: S3-backed (syra source / cached rss) ───────────────────────────────

async function serveFromS3(req: AuthRequest, res: Response, s3Key: string): Promise<void> {
  const metadata = await getObjectMetadata(s3Key);
  if (!metadata || metadata.contentLength === undefined) {
    res.status(404).json({ error: 'Audio not found' });
    return;
  }

  const totalSize = metadata.contentLength;
  const contentType = metadata.contentType ?? 'audio/mpeg';
  const range = parseRange(req.headers.range, totalSize);

  res.set('Accept-Ranges', 'bytes');
  res.set('Content-Type', contentType);
  res.set('Cache-Control', CACHE_CONTROL_AUDIO);

  if (range) {
    const { stream } = await streamFromS3(s3Key, { start: range.start, end: range.end });
    res.status(206);
    res.set('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`);
    res.set('Content-Length', String(range.end - range.start + 1));
    (stream as Readable).on('error', () => res.destroy());
    (stream as Readable).pipe(res);
    return;
  }

  const { stream } = await streamFromS3(s3Key);
  res.status(200);
  res.set('Content-Length', String(totalSize));
  (stream as Readable).on('error', () => res.destroy());
  (stream as Readable).pipe(res);
}

// ── /audio: SSRF-safe origin reverse proxy (external rss) ──────────────────────

async function proxyOrigin(req: AuthRequest, res: Response, episode: EpisodeRow): Promise<void> {
  if (!episode.enclosureUrl) {
    res.status(404).json({ error: 'No enclosure for episode' });
    return;
  }

  const headers: Record<string, string> = {};
  if (typeof req.headers.range === 'string') headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await safeFetch(episode.enclosureUrl, { headers });
  } catch (err) {
    if (err instanceof SsrfRejection) {
      res.status(403).json({ error: 'Blocked enclosure host' });
      return;
    }
    logger.warn('[podcasts] audio proxy upstream failed', { episodeId: episode.id, err: describeErrorSafely(err) });
    res.status(502).json({ error: 'Upstream audio unavailable' });
    return;
  }

  if (upstream.status < 200 || upstream.status >= 400) {
    upstream.response.destroy();
    res.status(502).json({ error: `Upstream returned ${upstream.status}` });
    return;
  }

  // Pass through the salient streaming headers from origin.
  res.status(upstream.status);
  const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
  for (const name of passthrough) {
    const value = upstream.headers[name];
    if (typeof value === 'string') res.set(name, value);
  }
  if (typeof upstream.headers['accept-ranges'] !== 'string') res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', CACHE_CONTROL_AUDIO);

  upstream.response.on('error', () => res.destroy());
  upstream.response.pipe(res);

  // Popularity-gated background cache (best-effort; does not affect this response).
  maybeCacheEpisode(episode);
}

/**
 * GET /api/podcasts/episodes/:id/audio — progressive audio.
 *
 * ANONYMOUS for `public` and `unlisted` shows, and that is load-bearing rather
 * than lax: this URL is the `<enclosure>` of the generated RSS feed, so Apple
 * Podcasts, Overcast and Podcast Index fetch it with no credentials, and it is
 * also the SSRF-safe origin proxy for mirrored RSS episodes. The gate keys on
 * the SHOW's audience, never on who is asking — a signed-in stranger gets
 * exactly what an anonymous one gets.
 *
 * `private` is the one case that asks, and the only answer it accepts is the
 * owner.
 */
export async function getEpisodeAudio(req: AuthRequest, res: Response): Promise<void> {
  const episodeId = getEpisodeIdParam(req);
  if (!episodeId) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  const found = await findEpisodeById(episodeId);
  if (!found || !isEpisodePlayable(found.episode)) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }
  const { episode, show } = found;

  // 404 rather than 403: a private show's episode must be indistinguishable from
  // an id that names nothing.
  if (!requestMayReachShowMedia(req, episodeId, show)) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }

  if (episode.source === 'syra') {
    if (!episode.audioSourceFormat) {
      res.status(404).json({ error: 'No audio for episode' });
      return;
    }
    const key = getS3PodcastEpisodeAudioKey(episodeId, episode.podcastId, episode.audioSourceFormat);
    await serveFromS3(req, res, key);
    return;
  }

  if (episode.cacheStatus === 'cached' && episode.cacheObjectKey) {
    await serveFromS3(req, res, episode.cacheObjectKey);
    return;
  }

  await proxyOrigin(req, res, episode);
}

// ── HLS stream (Syra-hosted episodes) ──────────────────────────────────────────

/**
 * GET /api/podcasts/episodes/:id/stream — resolver. Requires a bearer session
 * (mints the token). HLS only; external episodes use `/audio`.
 */
export async function getEpisodeStream(req: AuthRequest, res: Response): Promise<void> {
  const episodeId = getEpisodeIdParam(req);
  if (!episodeId) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  const found = await findEpisodeById(episodeId);
  if (!found || !isEpisodePlayable(found.episode)) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }
  const { episode, show } = found;

  if (!requestMayReachShowMedia(req, episodeId, show)) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }

  if (!req.user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (episode.status === 'processing') {
    res.status(409).json({ error: 'Episode processing' });
    return;
  }

  if (!episode.hlsMasterKey || (await episodeHls(episodeId)).length === 0) {
    res.status(422).json({ error: 'Episode has no HLS stream' });
    return;
  }

  const access = await resolveEpisodeAccess(req, episodeId, show);
  if (!access.ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = mintStreamToken(
    { trackId: episodeId, userId: req.user.id, maxBitrateKbps: access.maxBitrateKbps },
    STREAM_SESSION_TTL_SEC,
  );
  const base = env.STREAM_KEY_BASE_URL;
  const url = `${base}/api/podcasts/episodes/${episodeId}/master.m3u8?t=${token}`;
  const expiresAt = new Date(Date.now() + STREAM_SESSION_TTL_SEC * 1000).toISOString();

  res.set('Vary', 'Authorization');
  res.status(200).json({ url, type: 'hls', expiresAt });
}

/**
 * GET /api/podcasts/episodes/:id/key — AES-128 key (bearer or ?t= token).
 *
 * This handler loaded no episode row at all. It resolved a bitrate cap — which
 * any bearer session satisfies — and then read `track_keys` by the id in the
 * URL, so any signed-in user could ask for the content key of any episode,
 * including one whose show was taken down. The key IS the encryption; handing it
 * out makes the segments plaintext to whoever holds it.
 */
export async function getEpisodeStreamKey(req: AuthRequest, res: Response): Promise<void> {
  const episodeId = getEpisodeIdParam(req);
  if (!episodeId) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  const found = await findEpisodeById(episodeId);
  if (!found || !isEpisodePlayable(found.episode)) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }

  const access = await resolveEpisodeAccess(req, episodeId, found.show);
  if (!access.ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // `track_keys.episode_id`, NOT `track_id`: the table carries one column per
  // id space (see `schema/trackKeys.ts`), and this endpoint holds an episode
  // id. `storePackagedHls` files it under the same arm from `ingestEpisode`.
  const [trackKey] = await getDb()
    .select({ keyHex: trackKeys.keyHex })
    .from(trackKeys)
    .where(eq(trackKeys.episodeId, episodeId))
    .limit(1);
  if (!trackKey) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }

  res.set('Content-Type', CONTENT_TYPE_OCTET_STREAM);
  res.set('Cache-Control', CACHE_CONTROL_NO_STORE);
  res.status(200).send(Buffer.from(trackKey.keyHex, 'hex'));
}

/**
 * GET /api/podcasts/episodes/:id/master.m3u8 — master playlist (bearer or ?t=).
 */
export async function getEpisodeMasterPlaylist(req: AuthRequest, res: Response): Promise<void> {
  const episodeId = getEpisodeIdParam(req);
  if (!episodeId) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  // The episode (and its show) is loaded BEFORE the access check now: the check
  // needs the show, and the show is what the join exists to supply.
  const found = await findEpisodeById(episodeId);
  if (!found || !isEpisodePlayable(found.episode)) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }
  const { episode } = found;

  const access = await resolveEpisodeAccess(req, episodeId, found.show);
  if (!access.ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const hls = await episodeHls(episodeId);
  if (!episode.hlsMasterKey || hls.length === 0) {
    res.status(404).json({ error: 'Master playlist not available' });
    return;
  }

  const rawToken = req.query?.t;
  const token = typeof rawToken === 'string' && rawToken
    ? rawToken
    : mintStreamToken({ trackId: episodeId, userId: req.user?.id ?? '', maxBitrateKbps: access.maxBitrateKbps }, STREAM_SESSION_TTL_SEC);

  const baseUrl = env.STREAM_KEY_BASE_URL;
  const playlist = await buildMasterPlaylistFor(
    { id: episodeId, hls },
    { token, baseUrl, maxBitrateKbps: access.maxBitrateKbps, basePath: `/api/podcasts/episodes/${episodeId}` },
  );

  res.set('Content-Type', CONTENT_TYPE_HLS_PLAYLIST);
  res.set('Cache-Control', CACHE_CONTROL_PLAYLIST);
  res.set('Vary', 'Authorization');
  res.status(200).send(playlist);
}

/**
 * GET /api/podcasts/episodes/:id/v/:variant — variant playlist (bearer or ?t=).
 * Enforces the server-side bitrate cap.
 */
export async function getEpisodeVariantPlaylist(req: AuthRequest, res: Response): Promise<void> {
  const episodeId = getEpisodeIdParam(req);
  if (!episodeId) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  const found = await findEpisodeById(episodeId);
  if (!found || !isEpisodePlayable(found.episode)) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }

  const access = await resolveEpisodeAccess(req, episodeId, found.show);
  if (!access.ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const hls = await episodeHls(episodeId);
  if (hls.length === 0) {
    res.status(404).json({ error: 'Variant playlist not available' });
    return;
  }

  const variantParam = Array.isArray(req.params.variant) ? req.params.variant[0] : req.params.variant;
  const bitrateKbps = parseInt((variantParam ?? '').replace(/\.m3u8$/i, ''), 10);
  if (!Number.isInteger(bitrateKbps) || bitrateKbps <= 0) {
    res.status(400).json({ error: 'Invalid variant' });
    return;
  }
  if (!hls.some((r) => r.bitrateKbps === bitrateKbps)) {
    res.status(404).json({ error: `No rendition at ${bitrateKbps} kbps` });
    return;
  }
  if (bitrateKbps > access.maxBitrateKbps) {
    res.status(403).json({ error: 'Quality not permitted' });
    return;
  }

  const rawToken = req.query?.t;
  const token = typeof rawToken === 'string' && rawToken
    ? rawToken
    : mintStreamToken({ trackId: episodeId, userId: req.user?.id ?? '', maxBitrateKbps: access.maxBitrateKbps }, STREAM_SESSION_TTL_SEC);

  const baseUrl = env.STREAM_KEY_BASE_URL;
  const playlist = await buildVariantPlaylistFor(
    { id: episodeId, hls },
    { bitrateKbps, token, baseUrl, basePath: `/api/podcasts/episodes/${episodeId}` },
  );

  res.set('Content-Type', CONTENT_TYPE_HLS_PLAYLIST);
  res.set('Cache-Control', CACHE_CONTROL_PLAYLIST);
  res.set('Vary', 'Authorization');
  res.status(200).send(playlist);
}
