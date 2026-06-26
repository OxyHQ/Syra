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
  type AudioSource,
} from '@syra/shared-types';
import { PodcastModel } from '../models/Podcast';
import { EpisodeModel } from '../models/Episode';
import { UserLibraryModel } from '../models/Library';
import { ArtistModel } from '../models/Artist';
import { getParam } from '../utils/reqParams';
import { logger } from '../utils/logger';
import { searchPodcasts as directorySearch } from '../services/podcasts/PodcastDirectory';
import { importFeed } from '../services/podcasts/podcastImportService';
import { enqueuePodcastSearchImport } from '../services/podcasts/podcastBackgroundImport';
import { serializePodcast, serializeEpisode } from '../services/podcasts/podcastSerializers';
import { enqueueEpisodeIngest } from '../services/podcasts/ingestEpisode';
import { generatePodcastRss } from '../services/podcasts/podcastRssGenerator';
import { getS3PodcastEpisodeAudioKey } from '../config/s3.config';
import { uploadToS3 } from '../services/s3Service';
import { getImageAssetColors } from '../services/imageAssetService';

// ── Constants ──────────────────────────────────────────────────────────────────

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

function clampLimit(raw: unknown): number {
  const parsed = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return LIST_LIMIT_DEFAULT;
  return Math.min(LIST_LIMIT_MAX, Math.max(1, parsed));
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
 * GET /api/podcasts/search?q=&limit= — DB-first text search. Enriches the
 * catalog in the BACKGROUND from the whole directory result set (capped +
 * throttled + deduped) without blocking the response; newly imported shows
 * surface on subsequent searches. This replaces the old import-on-tap flow.
 */
export async function searchPodcasts(req: AuthRequest, res: Response): Promise<void> {
  const q = (queryString(req, 'q') ?? '').trim();
  if (!q) {
    res.status(400).json({ error: 'Query parameter q is required' });
    return;
  }
  const limit = clampLimit(req.query.limit);

  const podcasts = await PodcastModel.find(
    { status: 'active', $text: { $search: q } },
    { score: { $meta: 'textScore' } },
  )
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .lean();

  // Fire-and-forget bulk enrichment — never delays this response.
  enqueuePodcastSearchImport(q);

  res.json({ data: podcasts.map(serializePodcast) });
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
  const candidates = await directorySearch(q, clampLimit(req.query.limit));
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
  const limit = clampLimit(req.query.limit);
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

  const episodes = await EpisodeModel.find({
    podcastId: podcast._id,
    ...episodeVisibilityFilter(podcast.ownerOxyUserId, req.user?.id),
  })
    .sort({ pubDate: -1 })
    .limit(RECENT_EPISODES_ON_SHOW)
    .lean();

  res.json({ data: { podcast: serializePodcast(podcast), episodes: episodes.map(serializeEpisode) } });
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

  const podcast = await PodcastModel.findById(id).select('ownerOxyUserId status').lean();
  if (!podcast || podcast.status === 'removed') {
    res.status(404).json({ error: 'Podcast not found' });
    return;
  }

  const limit = clampLimit(req.query.limit);
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

  res.json({ data: episodes.map(serializeEpisode), total, page, limit });
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

  const baseUrl = process.env.STREAM_KEY_BASE_URL ?? '';
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
  const base = process.env.STREAM_KEY_BASE_URL ?? '';
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
      });

      const audioKey = getS3PodcastEpisodeAudioKey(episodeId.toString(), podcast._id.toString(), format);
      await uploadToS3(audioKey, file.buffer, { contentType: file.mimetype });
      await episode.save();

      await PodcastModel.updateOne(
        { _id: podcast._id },
        { $inc: { episodeCount: 1 }, $set: { lastEpisodeAt: episode.pubDate } },
      );

      enqueueEpisodeIngest(episodeId.toString());

      res.status(201).json({ data: serializeEpisode(episode) });
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
