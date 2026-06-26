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

import type { CatalogImageSizes } from '@syra/shared-types';
import { PodcastModel, IPodcast } from '../../models/Podcast';
import { EpisodeModel } from '../../models/Episode';
import { logger } from '../../utils/logger';
import { assignMissingColors, replaceColors } from '../catalog/entityColors';
import { fetchAndParse, type ParsedEpisode, type ParsedShow } from './RssConnector';
import { rehostPodcastImage } from './podcastMedia';
import type { PodcastDirectoryCandidate } from './PodcastDirectory';

/** Max NEW episodes whose own artwork is re-hosted inline per import (bounds the
 * import path; the long tail is covered by the backfill script). */
const MAX_EPISODE_IMAGE_REHOST = 30;

/** Cover-art fields applied to an episode upsert when it carries its own art. */
interface EpisodeMedia {
  image?: string;
  imageSizes?: CatalogImageSizes;
  primaryColor?: string;
  secondaryColor?: string;
  imageSourceUrl?: string;
}

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
  // `image`/`imageSizes`/colors are handled by the re-host step (post-upsert),
  // NOT here — we never store an external URL in `image`.
  return definedOnly({
    title: show.title,
    description: show.description,
    author: show.author ?? directory?.author,
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

function buildEpisodeSet(
  podcastTitle: string,
  episode: ParsedEpisode,
  media: EpisodeMedia | undefined,
): Record<string, unknown> {
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
    explicit: episode.explicit,
    chapters: episode.chapters,
    transcripts: episode.transcripts,
    persons: episode.persons,
    // Cover art (only when the episode carries its own; image is a Syra id).
    image: media?.image,
    imageSizes: media?.imageSizes,
    primaryColor: media?.primaryColor,
    secondaryColor: media?.secondaryColor,
    imageSourceUrl: media?.imageSourceUrl,
    // pubDate is set here only when parsed; the insert fallback handles the rest.
    ...(episode.pubDate ? { pubDate: episode.pubDate } : {}),
  });
}

/**
 * Re-host the show cover into Syra S3 and apply image/sizes/colors to the doc,
 * keeping the external URL only as a fallback. Mutates `podcast` (saved by the
 * caller). Colors follow the catalog convention: replace on change, fill-missing
 * when unchanged.
 */
async function applyShowCover(podcast: IPodcast, feedUrl: string, sourceImageUrl: string | undefined): Promise<void> {
  if (!sourceImageUrl) return;

  const previousImageId = podcast.image;
  const rehosted = await rehostPodcastImage(sourceImageUrl, {
    source: 'rss',
    entityType: 'podcast',
    externalId: podcast.podcastGuid ?? feedUrl,
    existingImageId: previousImageId,
    existingImageSizes: podcast.imageSizes,
  });

  // Keep the external artwork URL as a fallback regardless of re-host outcome.
  podcast.imageSourceUrl = sourceImageUrl;

  if (!rehosted) return;

  const changed = rehosted.image !== previousImageId;
  podcast.image = rehosted.image;
  podcast.imageSizes = rehosted.imageSizes;
  const colors = { primaryColor: rehosted.primaryColor, secondaryColor: rehosted.secondaryColor };
  if (changed) {
    replaceColors(podcast, colors);
  } else {
    assignMissingColors(podcast, colors);
  }
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
    existing.needsDeepImport = false;
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

  // Re-host the show cover (mirrors Artist) before the final save.
  const showImageUrl = fetched.show.image ?? options.directory?.image;
  try {
    await applyShowCover(podcast, feedUrl, showImageUrl);
  } catch (err) {
    logger.warn('[podcasts] show cover re-host failed', { feedUrl, err });
    if (showImageUrl) podcast.imageSourceUrl = showImageUrl;
  }

  let importedEpisodes = 0;
  let failedEpisodes = 0;
  let rehostedEpisodeImages = 0;

  for (const episode of fetched.episodes) {
    try {
      // Re-host a NEW episode's OWN artwork (distinct from the show), bounded.
      let media: EpisodeMedia | undefined;
      const ownArtUrl = episode.image;
      if (ownArtUrl && ownArtUrl !== showImageUrl) {
        const alreadyExists = await EpisodeModel.exists({ podcastId: podcast._id, guid: episode.guid });
        if (!alreadyExists) {
          if (rehostedEpisodeImages < MAX_EPISODE_IMAGE_REHOST) {
            const rehosted = await rehostPodcastImage(ownArtUrl, {
              source: 'rss',
              entityType: 'episode',
              externalId: episode.guid,
            });
            if (rehosted) {
              media = {
                image: rehosted.image,
                imageSizes: rehosted.imageSizes,
                primaryColor: rehosted.primaryColor,
                secondaryColor: rehosted.secondaryColor,
                imageSourceUrl: ownArtUrl,
              };
              rehostedEpisodeImages += 1;
            } else {
              media = { imageSourceUrl: ownArtUrl };
            }
          } else {
            // Beyond the per-import cap → keep the external URL as a fallback only.
            media = { imageSourceUrl: ownArtUrl };
          }
        }
        // Existing episode → leave its cover as-is (idempotent).
      }

      await EpisodeModel.findOneAndUpdate(
        { podcastId: podcast._id, guid: episode.guid },
        {
          $set: buildEpisodeSet(podcast.title, episode, media),
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
  podcast.needsDeepImport = false;
  if (fetched.etag) podcast.etag = fetched.etag;
  if (fetched.lastModified) podcast.lastModified = fetched.lastModified;
  await podcast.save();

  return { podcast, notModified: false, importedEpisodes, failedEpisodes };
}
