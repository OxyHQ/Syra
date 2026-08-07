/**
 * Podcasts controller — catalog reads (DB-first), discovery (directory →
 * on-the-fly import), user subscriptions, and the creator (Syra-hosted) surface:
 * create show, upload episode (→ shared HLS ingest), and the generated public
 * RSS feed.
 *
 * Auth: writes resolve the owner via `getRequiredOxyUserId` and use explicit
 * field whitelists (never a spread of `req.body`). Ids are validated with
 * `isLiveEntityId`, which accepts BOTH shapes this schema stores — a 24-char
 * ObjectId hex carried over from Mongo and a uuid v7 minted since. The old
 * `mongoose.Types.ObjectId.isValid` guard accepted only the first, so every show
 * and episode created after the cutover would have 400'd on its own detail page.
 *
 * ## `image` is a foreign key now, and a creator supplies it
 *
 * `podcasts.image_id` references `image_assets`. Mongo stored whatever string
 * the client sent; a bogus id here is `23503`. The create/update paths resolve
 * the asset BEFORE writing (they already read its colors) and reject an
 * unknown id with a 400 rather than letting a constraint violation reach the
 * client as a 500.
 */

import multer from 'multer';
import type { Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { isLiveEntityId, uuidv7 } from '@oxyhq/db';
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
import { getDb } from '../db/postgres';
import { catalogEntities, imageAssets } from '../db/schema/catalog';
import {
  browsePodcastRows,
  findPodcastById,
  findPodcastsByIds,
  findPodcastsByOwner,
  insertPodcast,
  searchPodcastRows,
  updatePodcast as updatePodcastRow,
} from '../db/podcasts/podcasts';
import {
  countEpisodesByShow,
  findEpisodesByShow,
  findFeedEpisodes,
  insertEpisode,
} from '../db/podcasts/episodes';
import {
  loadPodcastPersons,
  loadShowArtwork,
  toEpisodeDtos,
  toPodcastDtos,
} from '../db/podcasts/hydrate';
import { episodeVisibilityFilter } from '../db/podcasts/visibility';
import {
  listSubscribedPodcastIds,
  subscribeToPodcast,
  unsubscribeFromPodcast,
} from '../db/podcasts/subscriptions';
import { getParam, parseClampedLimit, parseOffset } from '../utils/reqParams';
import { logger } from '../utils/logger';
import { searchPodcasts as directorySearch } from '../services/podcasts/PodcastDirectory';
import { importFeed } from '../services/podcasts/podcastImportService';
import { syncPodcastSearch } from '../services/podcasts/podcastBackgroundImport';
import { resolvePersons, buildCreatorPersons, makeOxyUsersFetcher } from '../services/podcasts/resolvePersons';
import { enqueueEpisodeIngest } from '../services/podcasts/ingestEpisode';
import { generatePodcastRss } from '../services/podcasts/podcastRssGenerator';
import { getS3PodcastEpisodeAudioKey } from '../config/s3.config';
import { uploadToS3 } from '../services/s3Service';
import { oxy } from '../oxyClient';

// ── Constants ──────────────────────────────────────────────────────────────────

const LIST_LIMIT_MIN = 1;
const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 50;
const RECENT_EPISODES_ON_SHOW = 20;
/** Cap on items in a generated public RSS feed. */
const RSS_EPISODE_CAP = 300;

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

/** Serialize one show, loading its four child collections. */
async function serializeOne(row: Awaited<ReturnType<typeof findPodcastById>>) {
  if (!row) return undefined;
  const [dto] = await toPodcastDtos([row]);
  return dto;
}

// ── Reads ──────────────────────────────────────────────────────────────────────

/**
 * GET /api/podcasts/search?q=&limit=&offset= — instant directory-backed search.
 *
 * `syncPodcastSearch` shallow-upserts the directory candidates first (bounded +
 * throttled, never hangs) so they appear in THIS response like the old discover
 * screen; the heavy feed import runs in the background.
 *
 * Matching is `search_vector` now, not a case-insensitive regex. The regex was a
 * deliberate choice under Mongo — its own comment named `$text` as unavailable
 * because production runs with `autoIndex` off — and the Postgres GIN index is
 * built by a migration, so the constraint that forced it is gone. Word and
 * prefix matching with stemming, at a cost that does not grow with the
 * catalogue; infix matching is the accepted loss (`db/catalog/search.ts`).
 *
 * Paginated for infinite scroll: `offset` (zero-based, clamped `>= 0`) + `limit`
 * page the result set. `hasMore` is derived by over-fetching ONE row beyond the
 * page (no second count query over the whole table).
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

    // Over-fetch one row past the page so `hasMore` is known without a separate
    // count query against the full table.
    const rows = await searchPodcastRows(q, offset, limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.json({ data: await toPodcastDtos(page), hasMore, limit, offset });
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
    res.status(200).json({
      data: await serializeOne(result.podcast),
      importedEpisodes: result.importedEpisodes,
    });
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

  const rows = await browsePodcastRows({
    category: queryString(req, 'category'),
    sort: queryString(req, 'sort') === 'recent' ? 'recent' : 'popular',
    offset: (page - 1) * limit,
    limit,
  });

  res.json({ data: await toPodcastDtos(rows), page, limit });
}

/**
 * GET /api/podcasts/:id — show + most recent episodes.
 */
export async function getPodcast(req: AuthRequest, res: Response): Promise<void> {
  const id = getParam(req, 'id');
  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  const podcast = await findPodcastById(id);
  if (!podcast || podcast.status === 'removed') {
    res.status(404).json({ error: 'Podcast not found' });
    return;
  }

  // Show-level Hosts & Guests: the credits are a child table now, so they are
  // read here and handed to the resolver, which links them to `person` rows and
  // enriches Oxy-linked credits with their live avatar + displayName.
  const credits = (await loadPodcastPersons([podcast.id])).get(podcast.id) ?? [];

  const [episodeRows, persons, dto] = await Promise.all([
    findEpisodesByShow(podcast.id, {
      visibility: episodeVisibilityFilter(podcast.ownerOxyUserId, req.user?.id),
      limit: RECENT_EPISODES_ON_SHOW,
    }),
    resolvePersons(credits, makeOxyUsersFetcher(oxy)),
    serializeOne(podcast),
  ]);

  // The show is already loaded: cover-less episodes inherit its artwork from
  // the map built here rather than from a second query per episode.
  const artwork = await loadShowArtwork(episodeRows);

  res.json({
    data: {
      podcast: dto,
      episodes: await toEpisodeDtos(episodeRows, artwork),
      persons,
    },
  });
}

/**
 * GET /api/podcasts/:id/episodes?page=&limit= — paginated reverse-chrono list.
 */
export async function getPodcastEpisodes(req: AuthRequest, res: Response): Promise<void> {
  const id = getParam(req, 'id');
  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  const podcast = await findPodcastById(id);
  if (!podcast || podcast.status === 'removed') {
    res.status(404).json({ error: 'Podcast not found' });
    return;
  }

  const limit = parseClampedLimit(req.query.limit, { min: LIST_LIMIT_MIN, max: LIST_LIMIT_MAX, fallback: LIST_LIMIT_DEFAULT });
  const page = parsePage(req.query.page);

  // The owner sees processing/failed episodes too; others see only ready ones.
  const visibility = episodeVisibilityFilter(podcast.ownerOxyUserId, req.user?.id);

  const [episodeRows, total, artwork] = await Promise.all([
    findEpisodesByShow(podcast.id, { visibility, offset: (page - 1) * limit, limit }),
    countEpisodesByShow(podcast.id, visibility),
    loadShowArtwork([{ podcastId: podcast.id }]),
  ]);

  res.json({ data: await toEpisodeDtos(episodeRows, artwork), total, page, limit });
}

/**
 * GET /api/podcasts/:id/rss — generated public RSS for a Syra-hosted show.
 */
export async function getPodcastRss(req: AuthRequest, res: Response): Promise<void> {
  const id = getParam(req, 'id');
  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  const podcast = await findPodcastById(id);
  if (!podcast || podcast.source !== 'syra' || podcast.status === 'removed') {
    res.status(404).json({ error: 'Feed not found' });
    return;
  }

  const episodeRows = await findFeedEpisodes(podcast.id, RSS_EPISODE_CAP);
  const artwork = await loadShowArtwork([{ podcastId: podcast.id }]);

  const [dto] = await toPodcastDtos([podcast]);
  if (!dto) {
    res.status(404).json({ error: 'Feed not found' });
    return;
  }

  const xml = generatePodcastRss(
    dto,
    await toEpisodeDtos(episodeRows, artwork),
    env.STREAM_KEY_BASE_URL
  );

  res.set('Content-Type', 'application/rss+xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=900');
  res.status(200).send(xml);
}

// ── Subscriptions ──────────────────────────────────────────────────────────────

/**
 * POST /api/podcasts/:id/subscribe — idempotent; bumps subscriberCount once.
 *
 * The existence check the Mongo handler ran first is gone, and nothing is lost:
 * `user_podcast_subscriptions.podcast_id` is a foreign key, so a show that does
 * not exist is `23503` and `subscribeToPodcast` reports it as
 * `'missing-podcast'` — one round trip instead of two, and correct under a
 * concurrent delete, which the read-then-write never was.
 */
export async function subscribePodcast(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');
  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  const result = await subscribeToPodcast(userId, id);
  if (result === 'missing-podcast') {
    res.status(404).json({ error: 'Podcast not found' });
    return;
  }

  res.json({ ok: true });
}

/**
 * POST /api/podcasts/:id/unsubscribe — idempotent; decrements subscriberCount once.
 */
export async function unsubscribePodcast(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');
  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  await unsubscribeFromPodcast(userId, id);
  res.json({ ok: true });
}

/**
 * GET /api/podcasts/subscriptions — subscribed shows + new-episode signals.
 */
export async function getSubscriptions(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);

  const ids = await listSubscribedPodcastIds(userId);
  if (ids.length === 0) {
    res.json({ data: { subscriptions: [], total: 0, oxyUserId: userId } });
    return;
  }

  const rows = await findPodcastsByIds(ids);
  const dtos = await toPodcastDtos(rows);
  const subscriptions = dtos.map((podcast) => ({ podcast, lastEpisodeAt: podcast.lastEpisodeAt }));

  res.json({ data: { subscriptions, total: subscriptions.length, oxyUserId: userId } });
}

// ── Creator ──────────────────────────────────────────────────────────────────

/**
 * GET /api/podcasts/mine — shows owned by the caller, newest first (creator
 * dashboard). Auth required.
 */
export async function getMyPodcasts(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const rows = await findPodcastsByOwner(userId);
  res.json({ data: await toPodcastDtos(rows) });
}

/**
 * Resolve a creator-supplied cover to its `image_assets` row, or report that it
 * is unknown.
 *
 * `podcasts.image_id` is a foreign key, so an id naming no asset is a constraint
 * violation rather than the string Mongo silently stored. Checked here, before
 * the write, so the caller gets a 400 that names the problem.
 *
 * One query rather than `getImageAssetColors` plus an existence check: that
 * helper returns `undefined` BOTH for a missing asset and for one whose palette
 * was never extracted, so it cannot answer "does this exist" on its own — and
 * the difference is exactly what decides between a 400 and a show with no
 * gradient.
 */
async function resolveCover(
  imageId: string
): Promise<{ ok: true; primaryColor?: string; secondaryColor?: string } | { ok: false }> {
  if (!isLiveEntityId(imageId)) return { ok: false };

  const [asset] = await getDb()
    .select({ primaryColor: imageAssets.primaryColor, secondaryColor: imageAssets.secondaryColor })
    .from(imageAssets)
    .where(eq(imageAssets.id, imageId))
    .limit(1);

  if (!asset) return { ok: false };
  // `secondaryColor` alone is not a palette, matching `getImageAssetColors`.
  if (!asset.primaryColor) return { ok: true };
  return {
    ok: true,
    primaryColor: asset.primaryColor,
    secondaryColor: asset.secondaryColor ?? undefined,
  };
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

  // Hosts & Guests — Oxy user ids ONLY (validated; no free text).
  let persons: EpisodePerson[] = [];
  if (input.hosts?.length || input.guests?.length) {
    const built = await buildCreatorPersons(
      { hosts: input.hosts, guests: input.guests },
      makeOxyUsersFetcher(oxy)
    );
    if (built.invalidIds.length > 0) {
      res.status(400).json({ error: 'hosts/guests must be valid Oxy user ids', invalidIds: built.invalidIds });
      return;
    }
    persons = built.persons;
  }

  // Pull the gradient colors from the creator's uploaded cover (Syra image id),
  // matching how Album/Artist carry primaryColor.
  let imageId: string | null = null;
  let primaryColor: string | undefined;
  let secondaryColor: string | undefined;
  if (input.image) {
    const cover = await resolveCover(input.image);
    if (!cover.ok) {
      res.status(400).json({ error: 'Unknown cover image' });
      return;
    }
    imageId = input.image;
    primaryColor = cover.primaryColor;
    secondaryColor = cover.secondaryColor;
  }

  // The public RSS URL is derivable from the id, so the id is minted here rather
  // than left to the column default — the same reason `uploadEpisode` mints one.
  const id = uuidv7();

  const row = await insertPodcast(
    {
      id,
      title: input.title,
      description: input.description,
      author: input.author,
      imageId,
      primaryColor,
      secondaryColor,
      language: input.language,
      explicit: input.explicit ?? false,
      link: input.link,
      type: input.type ?? 'episodic',
      source: 'syra',
      ownerOxyUserId: userId,
      claimable: false,
      status: 'active',
      feedUrl: `${env.STREAM_KEY_BASE_URL}/api/podcasts/${id}/rss`,
    },
    { categories: input.categories ?? [], persons }
  );

  res.status(201).json({ data: await serializeOne(row) });
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
      if (!isLiveEntityId(id)) {
        res.status(400).json({ error: 'Invalid podcast ID' });
        return;
      }

      const podcast = await findPodcastById(id);
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
        const built = await buildCreatorPersons(
          { hosts: hostIds, guests: guestIds },
          makeOxyUsersFetcher(oxy)
        );
        if (built.invalidIds.length > 0) {
          res.status(400).json({ error: 'hosts/guests must be valid Oxy user ids', invalidIds: built.invalidIds });
          return;
        }
        episodePersons = built.persons;
      }

      const format = AUDIO_FORMAT_BY_MIME[file.mimetype] ?? 'mp3';
      const durationRaw = Number(req.body?.duration);
      const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 0;

      // Minted up front: it is both the S3 key and the episode's own `guid`.
      const episodeId = uuidv7();
      const pubDate = new Date();

      const audioKey = getS3PodcastEpisodeAudioKey(episodeId, podcast.id, format);
      await uploadToS3(audioKey, file.buffer, { contentType: file.mimetype });

      const episode = await insertEpisode(
        {
          id: episodeId,
          podcastId: podcast.id,
          podcastTitle: podcast.title,
          title,
          description: typeof req.body?.description === 'string' ? req.body.description : undefined,
          summary: typeof req.body?.summary === 'string' ? req.body.summary : undefined,
          guid: episodeId,
          duration,
          pubDate,
          episodeType: 'full',
          explicit: req.body?.explicit === 'true' || req.body?.explicit === true,
          source: 'syra',
          audioSourceUrl: `/api/podcasts/episodes/${episodeId}/audio`,
          audioSourceFormat: format,
          status: 'processing',
        },
        { persons: episodePersons },
        // The show's `episode_count`/`last_episode_at` move in the SAME
        // transaction as the row they describe — see `insertEpisode`.
        { recordOnShow: true }
      );

      enqueueEpisodeIngest(episodeId);

      // New episode has no cover of its own yet: inherit the loaded show's art.
      const artwork = await loadShowArtwork([{ podcastId: podcast.id }]);
      const [dto] = await toEpisodeDtos([episode], artwork);
      res.status(201).json({ data: dto });
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
  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  const podcast = await findPodcastById(id);
  if (!podcast) {
    res.status(404).json({ error: 'Podcast not found' });
    return;
  }
  // An RSS-mirrored show is somebody else's podcast that we imported from their
  // feed. Claiming one hands over `ownerOxyUserId` on the strength of nothing but
  // "I asked first", so it must stay closed until a feed-ownership proof exists
  // (the usual shape being a token the real owner publishes in their own feed).
  //
  // Nothing marks an RSS podcast `claimable` today, so this is not currently
  // reachable — which is precisely why it is worth writing down rather than
  // relying on. The protection is an absence, and the obvious next feature
  // ("claim your show") restores the flag without anyone re-deriving this.
  if (podcast.source === 'rss') {
    res.status(403).json({ error: 'RSS podcast claims require ownership verification' });
    return;
  }
  if (podcast.claimable !== true || podcast.claimedByOxyUserId) {
    res.status(409).json({ error: 'Podcast is not claimable' });
    return;
  }

  const linkedArtistIdRaw = typeof req.body?.linkedArtistId === 'string' ? req.body.linkedArtistId : undefined;
  let linkedArtistId: string | undefined;
  if (linkedArtistIdRaw) {
    if (!isLiveEntityId(linkedArtistIdRaw)) {
      res.status(400).json({ error: 'Invalid linkedArtistId' });
      return;
    }
    /**
     * IDOR guard: a caller may only link an artist they own or claimed — never
     * trust a body-supplied id to point at someone else's.
     *
     * `type = 'artist'` is stated. Mongoose's discriminator injected it into
     * `ArtistModel.findById`; one table with a `type` column does not, and
     * without it a caller could link their own PERSON row here and put it in a
     * column whose CHECK — `linked_artist_id is null or type = 'person'` on
     * `catalog_entities` — says nothing about what `podcasts.linked_artist_id`
     * may reference.
     */
    const [artist] = await getDb()
      .select({
        ownerOxyUserId: catalogEntities.ownerOxyUserId,
        claimedByOxyUserId: catalogEntities.claimedByOxyUserId,
      })
      .from(catalogEntities)
      .where(and(eq(catalogEntities.id, linkedArtistIdRaw), eq(catalogEntities.type, 'artist')))
      .limit(1);

    if (!artist || (artist.ownerOxyUserId !== userId && artist.claimedByOxyUserId !== userId)) {
      res.status(403).json({ error: 'You do not own the linked artist' });
      return;
    }
    linkedArtistId = linkedArtistIdRaw;
  }

  const updated = await updatePodcastRow(id, {
    claimedByOxyUserId: userId,
    ownerOxyUserId: userId,
    claimable: false,
    ...(linkedArtistId === undefined ? {} : { linkedArtistId }),
  });

  res.json({ data: await serializeOne(updated) });
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

  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  const parsed = updatePodcastRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    return;
  }

  const podcast = await findPodcastById(id);
  if (!podcast) {
    res.status(404).json({ error: 'Podcast not found' });
    return;
  }
  if (podcast.source !== 'syra' || podcast.ownerOxyUserId !== userId) {
    res.status(403).json({ error: 'You do not own this podcast' });
    return;
  }

  const updates = parsed.data;

  // Explicit field-by-field assignment — the parsed object is never spread onto the row.
  const values: Parameters<typeof updatePodcastRow>[1] = {};
  if (updates.title !== undefined) values.title = updates.title;
  if (updates.description !== undefined) values.description = updates.description;
  if (updates.author !== undefined) values.author = updates.author;
  if (updates.language !== undefined) values.language = updates.language;
  if (updates.explicit !== undefined) values.explicit = updates.explicit;
  if (updates.link !== undefined) values.link = updates.link;
  if (updates.type !== undefined) values.type = updates.type;

  if (updates.image !== undefined) {
    const cover = await resolveCover(updates.image);
    if (!cover.ok) {
      res.status(400).json({ error: 'Unknown cover image' });
      return;
    }
    values.imageId = updates.image;
    /**
     * `?? null`, and this is the same ORM difference Task 13 fixed on the
     * locker's own PATCH (`uploads.controller.ts`'s `updateUpload`).
     *
     * `resolveCover` answers `{ ok: true }` with NO palette for an asset that
     * carries none, and `secondaryColor: undefined` for one that has a primary
     * and no secondary. `definedOnly` then strips those keys, and drizzle would
     * strip them anyway — so `undefined` means "leave this column alone", where
     * Mongoose's `$set` builder + `save()` cleared it.
     *
     * "Leave alone" is right for the FEED REFRESH `definedOnly` exists for — a
     * crawl that carries no `<podcast:funding>` must not erase creator-added
     * links — and wrong here. This is a creator explicitly changing the cover,
     * and the new cover decides both accents INCLUDING deciding they are
     * absent. Without the coalesce the show keeps the previous cover's colours
     * forever, and the client renders a palette belonging to artwork that is no
     * longer there. Fixed at the call site rather than in `definedOnly`,
     * because that helper's other callers want exactly the semantics it has.
     */
    values.primaryColor = cover.primaryColor ?? null;
    values.secondaryColor = cover.secondaryColor ?? null;
  }

  const updated = await updatePodcastRow(
    id,
    values,
    updates.categories === undefined ? {} : { categories: updates.categories }
  );

  res.json({ data: await serializeOne(updated) });
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
  res: Response
): Promise<Awaited<ReturnType<typeof findPodcastById>>> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');

  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return undefined;
  }

  const podcast = await findPodcastById(id);
  if (!podcast) {
    res.status(404).json({ error: 'Podcast not found' });
    return undefined;
  }
  if (podcast.source !== 'syra' || podcast.ownerOxyUserId !== userId) {
    res.status(403).json({ error: 'You do not own this podcast' });
    return undefined;
  }
  if (podcast.status === 'removed') {
    res.status(409).json({
      error: 'Podcast removed',
      message: 'This show was removed by the platform and cannot be republished',
    });
    return undefined;
  }

  return podcast;
}

/**
 * POST /api/podcasts/:id/unpublish — hide a show from browse, search and discovery.
 *
 * Soft by design: `status: 'unavailable'` drops the show out of the `status = 'active'`
 * filter used by browse and search, while leaving the row, its episodes, and every
 * subscription intact so publishing again is lossless. Deliberately does NOT cascade to
 * episodes — the show disappears from discovery but an already-downloaded or
 * directly-linked episode keeps resolving.
 */
export async function unpublishPodcast(req: AuthRequest, res: Response): Promise<void> {
  const podcast = await loadOwnedShowOrRespond(req, res);
  if (!podcast) return;

  const updated = await updatePodcastRow(podcast.id, { status: 'unavailable' });
  res.json({ data: await serializeOne(updated) });
}

/** POST /api/podcasts/:id/publish — undo `unpublishPodcast`. */
export async function publishPodcast(req: AuthRequest, res: Response): Promise<void> {
  const podcast = await loadOwnedShowOrRespond(req, res);
  if (!podcast) return;

  const updated = await updatePodcastRow(podcast.id, { status: 'active' });
  res.json({ data: await serializeOne(updated) });
}
