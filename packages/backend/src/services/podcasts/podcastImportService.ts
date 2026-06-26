/**
 * Podcast import orchestrator — mirrors `services/sources/importService`.
 *
 * Flow: fetch+parse the RSS feed (SSRF-safe, conditional GET) → upsert the
 * `Podcast` (by feedUrl, falling back to podcastGuid when a feed moved) → upsert
 * each `Episode` by `{ podcastId, guid }`. Per-episode failures are isolated so
 * one malformed item never aborts the crawl. Refresh/HTTP-cache bookkeeping
 * (`etag`, `lastModified`, `episodeCount`, `lastEpisodeAt`, `lastRefreshedAt`)
 * is updated at the end.
 *
 * Writes use explicit field whitelists — never `new Model(parsed)` — and never
 * touch Syra-hosted audio fields (`audioSource`/`hls`) or per-episode cache
 * state on an existing row.
 */

import { PodcastModel, IPodcast } from '../../models/Podcast';
import { EpisodeModel } from '../../models/Episode';
import { logger } from '../../utils/logger';
import { fetchAndParse, type ParsedEpisode, type ParsedShow } from './RssConnector';
import type { PodcastDirectoryCandidate } from './PodcastDirectory';

export interface ImportFeedOptions {
  /** Bypass conditional GET (always re-parse the body). */
  force?: boolean;
  /** Directory metadata to enrich the show (podcastIndexId, appleCollectionId, …). */
  directory?: PodcastDirectoryCandidate;
}

export interface ImportFeedResult {
  podcast: IPodcast;
  notModified: boolean;
  importedEpisodes: number;
  failedEpisodes: number;
}

/** Build a `$set` object containing only defined values (never clobbers with undefined). */
function definedOnly(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function buildPodcastSet(show: ParsedShow, directory: PodcastDirectoryCandidate | undefined): Record<string, unknown> {
  const categories = show.categories.length > 0 ? show.categories : (directory?.categories ?? []);
  return definedOnly({
    title: show.title,
    description: show.description,
    author: show.author ?? directory?.author,
    image: show.image ?? directory?.image,
    language: show.language,
    categories,
    explicit: show.explicit,
    link: show.link,
    type: show.type,
    podcastGuid: show.podcastGuid,
    podcastIndexId: directory?.podcastIndexId,
    appleCollectionId: directory?.appleCollectionId,
    funding: show.funding,
  });
}

function buildEpisodeSet(podcastTitle: string, episode: ParsedEpisode): Record<string, unknown> {
  return definedOnly({
    podcastTitle,
    title: episode.title,
    description: episode.description,
    summary: episode.summary,
    enclosureUrl: episode.enclosureUrl,
    enclosureType: episode.enclosureType,
    enclosureLength: episode.enclosureLength,
    duration: episode.duration,
    season: episode.season,
    episodeNumber: episode.episodeNumber,
    episodeType: episode.episodeType,
    image: episode.image,
    explicit: episode.explicit,
    chapters: episode.chapters,
    transcripts: episode.transcripts,
    persons: episode.persons,
    // pubDate is set here only when parsed; the insert fallback handles the rest.
    ...(episode.pubDate ? { pubDate: episode.pubDate } : {}),
  });
}

/**
 * Fetch a feed and mirror it into the catalog. Idempotent: re-running upserts
 * the same show/episodes. Returns the (possibly unchanged) podcast plus counts.
 */
export async function importFeed(feedUrl: string, options: ImportFeedOptions = {}): Promise<ImportFeedResult> {
  const existing =
    (await PodcastModel.findOne({ feedUrl })) ??
    (options.directory?.podcastGuid
      ? await PodcastModel.findOne({ podcastGuid: options.directory.podcastGuid })
      : null);

  const fetched = await fetchAndParse(feedUrl, {
    etag: options.force ? undefined : existing?.etag,
    lastModified: options.force ? undefined : existing?.lastModified,
  });

  if (fetched.notModified && existing) {
    existing.lastRefreshedAt = new Date();
    await existing.save();
    return { podcast: existing, notModified: true, importedEpisodes: 0, failedEpisodes: 0 };
  }

  if (!fetched.show || !fetched.episodes) {
    throw new Error(`podcastImportService: empty parse result for ${feedUrl}`);
  }

  const filter = existing ? { _id: existing._id } : { feedUrl };
  const podcast = await PodcastModel.findOneAndUpdate(
    filter,
    {
      $set: buildPodcastSet(fetched.show, options.directory),
      $setOnInsert: {
        feedUrl,
        source: 'rss',
        status: 'active',
        claimable: true,
      },
    },
    { upsert: true, new: true },
  );

  if (!podcast) {
    throw new Error(`podcastImportService: failed to upsert podcast for ${feedUrl}`);
  }

  let importedEpisodes = 0;
  let failedEpisodes = 0;

  for (const episode of fetched.episodes) {
    try {
      await EpisodeModel.findOneAndUpdate(
        { podcastId: podcast._id, guid: episode.guid },
        {
          $set: buildEpisodeSet(podcast.title, episode),
          $setOnInsert: {
            source: 'rss',
            status: 'ready',
            cache: { status: 'none' },
            playCount: 0,
            popularity: 0,
            ...(episode.pubDate ? {} : { pubDate: new Date() }),
          },
        },
        { upsert: true, new: true },
      );
      importedEpisodes += 1;
    } catch (err) {
      logger.error('[podcasts] per-episode upsert failed', { feedUrl, guid: episode.guid, err });
      failedEpisodes += 1;
    }
  }

  const [episodeCount, latest] = await Promise.all([
    EpisodeModel.countDocuments({ podcastId: podcast._id }),
    EpisodeModel.findOne({ podcastId: podcast._id }).sort({ pubDate: -1 }).select('pubDate').lean(),
  ]);

  podcast.episodeCount = episodeCount;
  podcast.lastEpisodeAt = latest?.pubDate ?? podcast.lastEpisodeAt;
  podcast.lastRefreshedAt = new Date();
  if (fetched.etag) podcast.etag = fetched.etag;
  if (fetched.lastModified) podcast.lastModified = fetched.lastModified;
  await podcast.save();

  return { podcast, notModified: false, importedEpisodes, failedEpisodes };
}
