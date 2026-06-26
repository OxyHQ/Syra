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
 * (`resolveStreamAccess`, `mintStreamToken`, `buildMasterPlaylistFor`,
 * `buildVariantPlaylistFor`) and the `TrackKey` store keyed by the episode id —
 * no duplication of token/key logic.
 */

import mongoose from 'mongoose';
import type { Response } from 'express';
import { Readable } from 'stream';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { safeFetch, SsrfRejection } from '@oxyhq/core/server';
import { EpisodeModel, IEpisode } from '../models/Episode';
import { TrackKeyModel } from '../models/TrackKey';
import { getS3PodcastEpisodeAudioKey } from '../config/s3.config';
import { streamFromS3, getObjectMetadata } from '../services/s3Service';
import { resolveStreamAccess } from './stream.controller';
import { mintStreamToken } from '../services/stream/streamToken';
import { buildMasterPlaylistFor, buildVariantPlaylistFor } from '../services/stream/manifestService';
import { maybeCacheEpisode } from '../services/podcasts/podcastCache';
import { logger } from '../utils/logger';

const CONTENT_TYPE_OCTET_STREAM = 'application/octet-stream';
const CONTENT_TYPE_HLS_PLAYLIST = 'application/vnd.apple.mpegurl';
const CACHE_CONTROL_NO_STORE = 'no-store';
const CACHE_CONTROL_PLAYLIST = 'private, max-age=300, stale-while-revalidate=1800';
const CACHE_CONTROL_AUDIO = 'public, max-age=3600';
const STREAM_SESSION_TTL_SEC = 3600;

// ── Shared guards ──────────────────────────────────────────────────────────────

function getEpisodeIdParam(req: AuthRequest): string | undefined {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  return raw && mongoose.Types.ObjectId.isValid(raw) ? raw : undefined;
}

function isEpisodePlayable(episode: { status?: string }): boolean {
  return episode.status !== 'unavailable';
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

async function proxyOrigin(req: AuthRequest, res: Response, episode: IEpisode): Promise<void> {
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
    logger.warn('[podcasts] audio proxy upstream failed', { episodeId: episode._id.toString(), err });
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
 * GET /api/podcasts/episodes/:id/audio — public progressive audio.
 */
export async function getEpisodeAudio(req: AuthRequest, res: Response): Promise<void> {
  const episodeId = getEpisodeIdParam(req);
  if (!episodeId) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  const episode = await EpisodeModel.findById(episodeId);
  if (!episode || !isEpisodePlayable(episode)) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }

  if (episode.source === 'syra') {
    if (!episode.audioSource) {
      res.status(404).json({ error: 'No audio for episode' });
      return;
    }
    const key = getS3PodcastEpisodeAudioKey(episodeId, episode.podcastId.toString(), episode.audioSource.format);
    await serveFromS3(req, res, key);
    return;
  }

  if (episode.cache?.status === 'cached' && episode.cache.s3Key) {
    await serveFromS3(req, res, episode.cache.s3Key);
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

  const episode = await EpisodeModel.findById(episodeId).lean();
  if (!episode || !isEpisodePlayable(episode)) {
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

  if (!episode.hlsMasterKey || !episode.hls?.length) {
    res.status(422).json({ error: 'Episode has no HLS stream' });
    return;
  }

  const access = await resolveStreamAccess(req, episodeId);
  if (!access.ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = mintStreamToken(
    { trackId: episodeId, userId: req.user.id, maxBitrateKbps: access.maxBitrateKbps },
    STREAM_SESSION_TTL_SEC,
  );
  const base = process.env.STREAM_KEY_BASE_URL ?? '';
  const url = `${base}/api/podcasts/episodes/${episodeId}/master.m3u8?t=${token}`;
  const expiresAt = new Date(Date.now() + STREAM_SESSION_TTL_SEC * 1000).toISOString();

  res.set('Vary', 'Authorization');
  res.status(200).json({ url, type: 'hls', expiresAt });
}

/**
 * GET /api/podcasts/episodes/:id/key — AES-128 key (bearer or ?t= token).
 */
export async function getEpisodeStreamKey(req: AuthRequest, res: Response): Promise<void> {
  const episodeId = getEpisodeIdParam(req);
  if (!episodeId) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  const access = await resolveStreamAccess(req, episodeId);
  if (!access.ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const trackKey = await TrackKeyModel.findOne({ trackId: episodeId }).lean();
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

  const access = await resolveStreamAccess(req, episodeId);
  if (!access.ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const episode = await EpisodeModel.findById(episodeId).lean();
  if (!episode || !isEpisodePlayable(episode)) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }
  if (!episode.hlsMasterKey || !episode.hls?.length) {
    res.status(404).json({ error: 'Master playlist not available' });
    return;
  }

  const rawToken = req.query?.t;
  const token = typeof rawToken === 'string' && rawToken
    ? rawToken
    : mintStreamToken({ trackId: episodeId, userId: req.user?.id ?? '', maxBitrateKbps: access.maxBitrateKbps }, STREAM_SESSION_TTL_SEC);

  const baseUrl = process.env.STREAM_KEY_BASE_URL ?? '';
  const playlist = await buildMasterPlaylistFor(
    { id: episodeId, hls: episode.hls },
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

  const access = await resolveStreamAccess(req, episodeId);
  if (!access.ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const episode = await EpisodeModel.findById(episodeId).lean();
  if (!episode || !isEpisodePlayable(episode)) {
    res.status(404).json({ error: 'Episode not found' });
    return;
  }
  if (!episode.hls?.length) {
    res.status(404).json({ error: 'Variant playlist not available' });
    return;
  }

  const variantParam = Array.isArray(req.params.variant) ? req.params.variant[0] : req.params.variant;
  const bitrateKbps = parseInt((variantParam ?? '').replace(/\.m3u8$/i, ''), 10);
  if (!Number.isInteger(bitrateKbps) || bitrateKbps <= 0) {
    res.status(400).json({ error: 'Invalid variant' });
    return;
  }
  if (!episode.hls.some((r) => r.bitrateKbps === bitrateKbps)) {
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

  const baseUrl = process.env.STREAM_KEY_BASE_URL ?? '';
  const playlist = await buildVariantPlaylistFor(
    { id: episodeId, hls: episode.hls },
    { bitrateKbps, token, baseUrl, basePath: `/api/podcasts/episodes/${episodeId}` },
  );

  res.set('Content-Type', CONTENT_TYPE_HLS_PLAYLIST);
  res.set('Cache-Control', CACHE_CONTROL_PLAYLIST);
  res.set('Vary', 'Authorization');
  res.status(200).send(playlist);
}
