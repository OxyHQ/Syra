/**
 * Podcasts controller — catalog reads (DB-first), discovery (directory →
 * on-the-fly import), user subscriptions, and the creator (Syra-hosted) surface:
 * create show, upload episode (→ shared HLS ingest), and the generated public
 * RSS feed.
 *
 * Auth: writes resolve the owner via `getRequiredOxyUserId` and use explicit
 * field whitelists (never `new Model(req.body)`). ObjectId params are validated;
 * ObjectIds are serialized to strings at the API boundary.
 */

import mongoose from 'mongoose';
import multer from 'multer';
import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import {
  createPodcastRequestSchema,
  importFeedRequestSchema,
  updatePodcastRequestSchema,
  type AudioSource,
  type EpisodePerson,
} from '@syra/shared-types';
import { env } from '../config/env';
import { PodcastModel, type IPodcast } from '../models/Podcast';
import { EpisodeModel } from '../models/Episode';
import { UserLibraryModel } from '../models/Library';
import { ArtistModel } from '../models/CatalogEntity';
import { getParam, parseClampedLimit, parseOffset } from '../utils/reqParams';
import { logger } from '../utils/logger';
import { searchPodcasts as directorySearch } from '../services/podcasts/PodcastDirectory';
import { importFeed } from '../services/podcasts/podcastImportService';
import { syncPodcastSearch } from '../services/podcasts/podcastBackgroundImport';
import { serializePodcast, serializeEpisode } from '../services/podcasts/podcastSerializers';
import { PODCAST_ARTWORK_PROJECTION } from '../services/podcasts/episodeShowArtwork';
import { resolvePersons, buildCreatorPersons, makeOxyUsersFetcher } from '../services/podcasts/resolvePersons';
import { enqueueEpisodeIngest } from '../services/podcasts/ingestEpisode';
import { generatePodcastRss } from '../services/podcasts/podcastRssGenerator';
import { getS3PodcastEpisodeAudioKey } from '../config/s3.config';
import { uploadToS3 } from '../services/s3Service';
import { getImageAssetColors } from '../services/imageAssetService';
import { oxy } from '../oxyClient';

// ── Constants ──────────────────────────────────────────────────────────────────

const LIST_LIMIT_MIN = 1;
const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 50;
const RECENT_EPISODES_ON_SHOW = 20;

const AUDIO_FORMAT_BY_MIME: Record<string, AudioSource['format']> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/vorbis': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

const episodeAudioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB — podcast episodes run long
  fileFilter: (_req, file, cb) => {
    if (AUDIO_FORMAT_BY_MIME[file.mimetype]) cb(null, true);
    else cb(new Error('Invalid file type. Only audio files are allowed.'));
  },
}).single('audioFile');

interface AudioUploadRequest extends AuthRequest {
  file?: Express.Multer.File;
}

function parsePage(raw: unknown): number {
  const parsed = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** Read a string query param (Express types query values loosely). */
function queryString(req: AuthRequest, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === 'string' ? value : undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse an id array from a multipart form field — accepts a real array, a JSON
 * array string (`["a","b"]`), or a comma-separated string.
 */
function parseIdArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return trimmed.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
}

/**
 * Episode visibility filter. The show owner sees every episode (including
 * `processing`/`failed`); everyone else sees only `ready` episodes.
 */
function episodeVisibilityFilter(
  ownerOxyUserId: string | undefined,
  viewerId: string | undefined,
): Record<string, unknown> {
  const isOwner = !!viewerId && viewerId === ownerOxyUserId;
  return isOwner ? {} : { status: 'ready' };
}

// ── Reads ──────────────────────────────────────────────────────────────────────

/**
 * GET /api/podcasts/search?q=&limit=&offset= — instant directory-backed search.
 *
 * `syncPodcastSearch` shallow-upserts the directory candidates first (bounded +
 * throttled, never hangs) so they appear in THIS response like the old discover
 * screen; the heavy feed import runs in the background. Uses a case-insensitive
 * regex (NOT `$text`) to avoid depending on a text index that is not built in
 * production (`autoIndex` is off) — that was the 502/504 cause. Wrapped so the
 * handler ALWAYS responds.
 *
 * Paginated for infinite scroll: `offset` (zero-based, clamped `>= 0`) + `limit`
 * page the result set. `hasMore` is derived by over-fetching ONE row beyond the
 * page (no second count query over the whole collection).
 */
export async function searchPodcasts(req: AuthRequest, res: Response): Promise<void> {
  const q = (queryString(req, 'q') ?? '').trim();
  if (!q) {
    res.status(400).json({ error: 'Query parameter q is required' });
    return;
  }
  const limit = parseClampedLimit(req.query.limit, { min: LIST_LIMIT_MIN, max: LIST_LIMIT_MAX, fallback: LIST_LIMIT_DEFAULT });
  const offset = parseOffset(req.query.offset);

  try {
    // Instant enrichment (shallow upsert) before we read — bounded + throttled.
    await syncPodcastSearch(q);

    const regex = new RegExp(escapeRegex(q), 'i');
    // Over-fetch one row past the page so `hasMore` is known without a separate
    // count query against the full collection.
    const rows = await PodcastModel.find({
      status: 'active',
      $or: [{ title: regex }, { author: regex }],
    })
      .sort({ popularity: -1, subscriberCount: -1, lastEpisodeAt: -1 })
      .skip(offset)
      .limit(limit + 1)
      .lean();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.json({ data: page.map(serializePodcast), hasMore, limit, offset });
  } catch (err) {
    logger.error('[podcasts] search failed', { q, err });
    if (!res.headersSent) res.status(500).json({ error: 'Search failed' });
  }
}

/**
 * GET /api/podcasts/discover?q= — directory candidates (Podcast Index + Apple).
 * Not persisted; the client imports a selection via POST /api/podcasts/import.
 */
export async function discoverPodcasts(req: AuthRequest, res: Response): Promise<void> {
  const q = (queryString(req, 'q') ?? '').trim();
  if (!q) {
    res.status(400).json({ error: 'Query parameter q is required' });
    return;
  }
  const candidates = await directorySearch(q, parseClampedLimit(req.query.limit, { min: LIST_LIMIT_MIN, max: LIST_LIMIT_MAX, fallback: LIST_LIMIT_DEFAULT }));
  res.json({ data: candidates });
}

/**
 * POST /api/podcasts/import — mirror an external feed into the catalog (auth).
 */
export async function importPodcast(req: AuthRequest, res: Response): Promise<void> {
  getRequiredOxyUserId(req);
  const parsed = importFeedRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'feedUrl is required' });
    return;
  }

  try {
    const result = await importFeed(parsed.data.feedUrl);
    res.status(200).json({ data: serializePodcast(result.podcast), importedEpisodes: result.importedEpisodes });
  } catch (err) {
    logger.warn('[podcasts] manual import failed', { feedUrl: parsed.data.feedUrl, err });
    res.status(502).json({ error: 'Failed to import feed' });
  }
}

/**
 * GET /api/podcasts?category=&sort=popular|recent — DB browse.
 */
export async function browsePodcasts(req: AuthRequest, res: Response): Promise<void> {
  const limit = parseClampedLimit(req.query.limit, { min: LIST_LIMIT_MIN, max: LIST_LIMIT_MAX, fallback: LIST_LIMIT_DEFAULT });
  const page = parsePage(req.query.page);
  const category = queryString(req, 'category');
  const sort = queryString(req, 'sort');

  const filter: Record<string, unknown> = { status: 'active' };
  if (category) filter.categories = category;

  const sortSpec: Record<string, 1 | -1> = sort === 'recent' ? { lastEpisodeAt: -1 } : { popularity: -1, subscriberCount: -1 };

  const podcasts = await PodcastModel.find(filter)
    .sort(sortSpec)
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.json({ data: podcasts.map(serializePodcast), page, limit });
}

/**
 * GET /api/podcasts/:id — show + most recent episodes.
 */
export async function getPodcast(req: AuthRequest, res: Response): Promise<void> {
  const id = getParam(req, 'id');
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  const podcast = await PodcastModel.findById(id).lean();
  if (!podcast || podcast.status === 'removed') {
    res.status(404).json({ error: 'Podcast not found' });
    return;
  }

  const [episodes, persons] = await Promise.all([
    EpisodeModel.find({
      podcastId: podcast._id,
      ...episodeVisibilityFilter(podcast.ownerOxyUserId, req.user?.id),
    })
      .sort({ pubDate: -1 })
      .limit(RECENT_EPISODES_ON_SHOW)
      .lean(),
    // Show-level Hosts & Guests: resolve channel persons to Person/Artist links
    // + enrich Oxy-linked credits with their live avatar + displayName.
    resolvePersons(podcast.persons, makeOxyUsersFetcher(oxy)),
  ]);

  res.json({
    data: {
      podcast: serializePodcast(podcast),
      // Show already loaded: cover-less episodes inherit its artwork directly.
      episodes: episodes.map((episode) => serializeEpisode(episode, podcast)),
      persons,
    },
  });
}

/**
 * GET /api/podcasts/:id/episodes?page=&limit= — paginated reverse-chrono list.
 */
export async function getPodcastEpisodes(req: AuthRequest, res: Response): Promise<void> {
  const id = getParam(req, 'id');
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  // Also project the show's artwork so cover-less episodes inherit it (no N+1).
  const podcast = await PodcastModel.findById(id)
    .select(`ownerOxyUserId status ${PODCAST_ARTWORK_PROJECTION}`)
    .lean();
  if (!podcast || podcast.status === 'removed') {
    res.status(404).json({ error: 'Podcast not found' });
    return;
  }

  const limit = parseClampedLimit(req.query.limit, { min: LIST_LIMIT_MIN, max: LIST_LIMIT_MAX, fallback: LIST_LIMIT_DEFAULT });
  const page = parsePage(req.query.page);

  // The owner sees processing/failed episodes too; others see only ready ones.
  const filter = { podcastId: id, ...episodeVisibilityFilter(podcast.ownerOxyUserId, req.user?.id) };

  const [episodes, total] = await Promise.all([
    EpisodeModel.find(filter)
      .sort({ pubDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    EpisodeModel.countDocuments(filter),
  ]);

  res.json({ data: episodes.map((episode) => serializeEpisode(episode, podcast)), total, page, limit });
}

/**
 * GET /api/podcasts/:id/rss — generated public RSS for a Syra-hosted show.
 */
export async function getPodcastRss(req: AuthRequest, res: Response): Promise<void> {
  const id = getParam(req, 'id');
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  const podcast = await PodcastModel.findById(id);
  if (!podcast || podcast.source !== 'syra' || podcast.status === 'removed') {
    res.status(404).json({ error: 'Feed not found' });
    return;
  }

  const episodes = await EpisodeModel.find({ podcastId: podcast._id, status: { $ne: 'unavailable' } })
    .sort({ pubDate: -1 })
    .limit(300);

  const baseUrl = env.STREAM_KEY_BASE_URL;
  const xml = generatePodcastRss(podcast, episodes, baseUrl);

  res.set('Content-Type', 'application/rss+xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=900');
  res.status(200).send(xml);
}

// ── Subscriptions ──────────────────────────────────────────────────────────────

/**
 * POST /api/podcasts/:id/subscribe — idempotent; bumps subscriberCount once.
 */
export async function subscribePodcast(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  const podcast = await PodcastModel.findById(id).select('_id').lean();
  if (!podcast) {
    res.status(404).json({ error: 'Podcast not found' });
    return;
  }

  const before = await UserLibraryModel.findOne({ oxyUserId: userId }).select('subscribedPodcasts').lean();
  const already = before?.subscribedPodcasts?.includes(id) ?? false;

  await UserLibraryModel.findOneAndUpdate(
    { oxyUserId: userId },
    { $addToSet: { subscribedPodcasts: id } },
    { upsert: true },
  );
  if (!already) {
    await PodcastModel.updateOne({ _id: id }, { $inc: { subscriberCount: 1 } });
  }

  res.json({ ok: true });
}

/**
 * POST /api/podcasts/:id/unsubscribe — idempotent; decrements subscriberCount once.
 */
export async function unsubscribePodcast(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  const before = await UserLibraryModel.findOne({ oxyUserId: userId }).select('subscribedPodcasts').lean();
  const wasSubscribed = before?.subscribedPodcasts?.includes(id) ?? false;

  await UserLibraryModel.findOneAndUpdate(
    { oxyUserId: userId },
    { $pull: { subscribedPodcasts: id } },
    { upsert: true },
  );
  if (wasSubscribed) {
    await PodcastModel.updateOne({ _id: id, subscriberCount: { $gt: 0 } }, { $inc: { subscriberCount: -1 } });
  }

  res.json({ ok: true });
}

/**
 * GET /api/podcasts/subscriptions — subscribed shows + new-episode signals.
 */
export async function getSubscriptions(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);

  const library = await UserLibraryModel.findOne({ oxyUserId: userId }).select('subscribedPodcasts').lean();
  const ids = (library?.subscribedPodcasts ?? []).filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (ids.length === 0) {
    res.json({ data: { subscriptions: [], total: 0, oxyUserId: userId } });
    return;
  }

  const podcasts = await PodcastModel.find({ _id: { $in: ids } }).lean();
  const subscriptions = podcasts.map((podcast) => ({
    podcast: serializePodcast(podcast),
    lastEpisodeAt: podcast.lastEpisodeAt ? podcast.lastEpisodeAt.toISOString() : undefined,
  }));

  res.json({ data: { subscriptions, total: subscriptions.length, oxyUserId: userId } });
}

// ── Creator ──────────────────────────────────────────────────────────────────

/**
 * GET /api/podcasts/mine — shows owned by the caller, newest first (creator
 * dashboard). Auth required.
 */
export async function getMyPodcasts(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const podcasts = await PodcastModel.find({ ownerOxyUserId: userId }).sort({ createdAt: -1 }).lean();
  res.json({ data: podcasts.map(serializePodcast) });
}

/**
 * POST /api/podcasts — create a Syra-hosted show (auth, field whitelist).
 */
export async function createPodcast(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const parsed = createPodcastRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid podcast payload' });
    return;
  }
  const input = parsed.data;

  const podcast = new PodcastModel({
    title: input.title,
    description: input.description,
    author: input.author,
    image: input.image,
    language: input.language,
    categories: input.categories ?? [],
    explicit: input.explicit ?? false,
    link: input.link,
    type: input.type ?? 'episodic',
    source: 'syra',
    ownerOxyUserId: userId,
    claimable: false,
    status: 'active',
  });

  // Hosts & Guests — Oxy user ids ONLY (validated; no free text).
  if (input.hosts?.length || input.guests?.length) {
    const { persons, invalidIds } = await buildCreatorPersons(
      { hosts: input.hosts, guests: input.guests },
      makeOxyUsersFetcher(oxy),
    );
    if (invalidIds.length > 0) {
      res.status(400).json({ error: 'hosts/guests must be valid Oxy user ids', invalidIds });
      return;
    }
    podcast.persons = persons;
  }

  // Pull the gradient colors from the creator's uploaded cover (Syra image id),
  // matching how Album/Artist carry primaryColor. Best-effort.
  if (input.image && mongoose.Types.ObjectId.isValid(input.image)) {
    const colors = await getImageAssetColors(input.image);
    if (colors) {
      podcast.primaryColor = colors.primaryColor;
      podcast.secondaryColor = colors.secondaryColor;
    }
  }

  // The public RSS URL is derivable from the id; persist it so it's queryable.
  const base = env.STREAM_KEY_BASE_URL;
  podcast.feedUrl = `${base}/api/podcasts/${podcast._id.toString()}/rss`;
  await podcast.save();

  res.status(201).json({ data: serializePodcast(podcast) });
}

/**
 * POST /api/podcasts/:id/episodes — upload an episode (auth, owner check).
 * Audio → S3 → shared HLS ingest. Episode starts `status: 'processing'`.
 */
export async function uploadEpisode(req: AuthRequest, res: Response): Promise<void> {
  episodeAudioUpload(req, res, async (uploadErr) => {
    if (uploadErr) {
      res.status(400).json({ error: 'Upload error', message: uploadErr.message });
      return;
    }

    try {
      const userId = getRequiredOxyUserId(req);
      const id = getParam(req, 'id');
      if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({ error: 'Invalid podcast ID' });
        return;
      }

      const podcast = await PodcastModel.findById(id);
      if (!podcast) {
        res.status(404).json({ error: 'Podcast not found' });
        return;
      }
      if (podcast.source !== 'syra' || podcast.ownerOxyUserId !== userId) {
        res.status(403).json({ error: 'You do not own this podcast' });
        return;
      }

      const file = (req as AudioUploadRequest).file;
      if (!file) {
        res.status(400).json({ error: 'Audio file is required' });
        return;
      }

      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      if (!title) {
        res.status(400).json({ error: 'Title is required' });
        return;
      }

      // Hosts & Guests — Oxy user ids ONLY, validated BEFORE any S3 upload.
      const hostIds = parseIdArray(req.body?.hosts);
      const guestIds = parseIdArray(req.body?.guests);
      let episodePersons: EpisodePerson[] = [];
      if (hostIds.length > 0 || guestIds.length > 0) {
        const { persons, invalidIds } = await buildCreatorPersons(
          { hosts: hostIds, guests: guestIds },
          makeOxyUsersFetcher(oxy),
        );
        if (invalidIds.length > 0) {
          res.status(400).json({ error: 'hosts/guests must be valid Oxy user ids', invalidIds });
          return;
        }
        episodePersons = persons;
      }

      const format = AUDIO_FORMAT_BY_MIME[file.mimetype] ?? 'mp3';
      const durationRaw = Number(req.body?.duration);
      const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 0;

      const episodeId = new mongoose.Types.ObjectId();
      const episode = new EpisodeModel({
        _id: episodeId,
        podcastId: podcast._id,
        podcastTitle: podcast.title,
        title,
        description: typeof req.body?.description === 'string' ? req.body.description : undefined,
        summary: typeof req.body?.summary === 'string' ? req.body.summary : undefined,
        guid: episodeId.toString(),
        duration,
        pubDate: new Date(),
        episodeType: 'full',
        explicit: req.body?.explicit === 'true' || req.body?.explicit === true,
        source: 'syra',
        audioSource: { url: `/api/podcasts/episodes/${episodeId.toString()}/audio`, format },
        status: 'processing',
        persons: episodePersons,
      });

      const audioKey = getS3PodcastEpisodeAudioKey(episodeId.toString(), podcast._id.toString(), format);
      await uploadToS3(audioKey, file.buffer, { contentType: file.mimetype });
      await episode.save();

      await PodcastModel.updateOne(
        { _id: podcast._id },
        { $inc: { episodeCount: 1 }, $set: { lastEpisodeAt: episode.pubDate } },
      );

      enqueueEpisodeIngest(episodeId.toString());

      // New episode has no cover of its own yet: inherit the loaded show's art.
      res.status(201).json({ data: serializeEpisode(episode, podcast) });
    } catch (err) {
      logger.error('[podcasts] episode upload failed', { err });
      if (!res.headersSent) res.status(500).json({ error: 'Failed to upload episode' });
    }
  });
}

/**
 * POST /api/podcasts/:id/claim — claim a claimable show; optionally link an
 * artist the caller owns. Auth + field whitelist.
 */
export async function claimPodcast(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  const podcast = await PodcastModel.findById(id);
  if (!podcast) {
    res.status(404).json({ error: 'Podcast not found' });
    return;
  }
  if (podcast.claimable !== true || podcast.claimedByOxyUserId) {
    res.status(409).json({ error: 'Podcast is not claimable' });
    return;
  }

  const linkedArtistIdRaw = typeof req.body?.linkedArtistId === 'string' ? req.body.linkedArtistId : undefined;
  if (linkedArtistIdRaw) {
    if (!mongoose.Types.ObjectId.isValid(linkedArtistIdRaw)) {
      res.status(400).json({ error: 'Invalid linkedArtistId' });
      return;
    }
    // IDOR guard: a caller may only link an Artist they own/claimed — never
    // trust a body-supplied id to point at someone else's artist.
    const artist = await ArtistModel.findById(linkedArtistIdRaw)
      .select('ownerOxyUserId claimedByOxyUserId')
      .lean();
    if (!artist || (artist.ownerOxyUserId !== userId && artist.claimedByOxyUserId !== userId)) {
      res.status(403).json({ error: 'You do not own the linked artist' });
      return;
    }
    podcast.linkedArtistId = new mongoose.Types.ObjectId(linkedArtistIdRaw);
  }

  podcast.claimedByOxyUserId = userId;
  podcast.ownerOxyUserId = userId;
  podcast.claimable = false;
  await podcast.save();

  res.json({ data: serializePodcast(podcast) });
}

/**
 * PATCH /api/podcasts/:id — edit a Syra-hosted show you own.
 *
 * Same ownership rule as `uploadEpisode`: `source === 'syra'` plus `ownerOxyUserId`.
 * RSS-mirrored shows are excluded because their fields are overwritten by the next feed
 * refresh, and claiming a show (`claimedByOxyUserId`) deliberately does not grant write
 * access — it never has for episode upload either. The body is parsed against the shared
 * schema and assigned field by field, so `source`, `status`, ownership, and the feed
 * bookkeeping fields stay unreachable.
 */
export async function updatePodcast(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  const parsed = updatePodcastRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    return;
  }

  const podcast = await PodcastModel.findById(id);
  if (!podcast) {
    res.status(404).json({ error: 'Podcast not found' });
    return;
  }
  if (podcast.source !== 'syra' || podcast.ownerOxyUserId !== userId) {
    res.status(403).json({ error: 'You do not own this podcast' });
    return;
  }

  const updates = parsed.data;

  // Explicit field-by-field assignment — the parsed object is never spread onto the doc.
  if (updates.title !== undefined) podcast.title = updates.title;
  if (updates.description !== undefined) podcast.description = updates.description;
  if (updates.author !== undefined) podcast.author = updates.author;
  if (updates.image !== undefined) podcast.image = updates.image;
  if (updates.language !== undefined) podcast.language = updates.language;
  if (updates.categories !== undefined) podcast.categories = updates.categories;
  if (updates.explicit !== undefined) podcast.explicit = updates.explicit;
  if (updates.link !== undefined) podcast.link = updates.link;
  if (updates.type !== undefined) podcast.type = updates.type;

  await podcast.save();

  res.json({ data: serializePodcast(podcast) });
}

/**
 * Load a Syra-hosted show the caller owns, or send the matching error response.
 *
 * Returns null once a response has been sent, so callers `if (!podcast) return;`.
 * `status: 'removed'` is a platform takedown, not a creator-reversible state, so a
 * creator cannot publish their way back out of it.
 */
async function loadOwnedShowOrRespond(
  req: AuthRequest,
  res: Response,
): Promise<IPodcast | null> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return null;
  }

  const podcast = await PodcastModel.findById(id);
  if (!podcast) {
    res.status(404).json({ error: 'Podcast not found' });
    return null;
  }
  if (podcast.source !== 'syra' || podcast.ownerOxyUserId !== userId) {
    res.status(403).json({ error: 'You do not own this podcast' });
    return null;
  }
  if (podcast.status === 'removed') {
    res.status(409).json({
      error: 'Podcast removed',
      message: 'This show was removed by the platform and cannot be republished',
    });
    return null;
  }

  return podcast;
}

/**
 * POST /api/podcasts/:id/unpublish — hide a show from browse, search and discovery.
 *
 * Soft by design: `status: 'unavailable'` drops the show out of the `{status:'active'}`
 * filter used by browse (podcasts.controller browse filter) and search, while leaving the
 * document, its episodes, and every subscription intact so publishing again is lossless.
 * Deliberately does NOT cascade to episodes — the show disappears from discovery but an
 * already-downloaded or directly-linked episode keeps resolving.
 */
export async function unpublishPodcast(req: AuthRequest, res: Response): Promise<void> {
  const podcast = await loadOwnedShowOrRespond(req, res);
  if (!podcast) return;

  podcast.status = 'unavailable';
  await podcast.save();

  res.json({ data: serializePodcast(podcast) });
}

/** POST /api/podcasts/:id/publish — undo `unpublishPodcast`. */
export async function publishPodcast(req: AuthRequest, res: Response): Promise<void> {
  const podcast = await loadOwnedShowOrRespond(req, res);
  if (!podcast) return;

  podcast.status = 'active';
  await podcast.save();

  res.json({ data: serializePodcast(podcast) });
}
