/**
 * Podcast import orchestrator: fetch a feed, upsert the show and its episodes.
 *
 * Flow: fetch+parse the RSS feed (SSRF-safe, conditional GET) → upsert the show
 * (by `feed_url`, falling back to `podcast_guid` when a feed moved) → upsert each
 * episode by `(podcast_id, guid)`. Per-episode failures are isolated so one
 * malformed item never aborts the crawl. Refresh/HTTP-cache bookkeeping (`etag`,
 * `last_modified`, `episode_count`, `last_episode_at`, `last_refreshed_at`) is
 * updated at the end.
 *
 * Writes use explicit field whitelists — never the parsed object spread — and
 * never touch Syra-hosted audio fields (`audio_source_*`, the HLS ladder) or
 * per-episode cache state on an existing row.
 *
 * ## This is the one vertical that mirrors an external authority
 *
 * Syra's music catalogue has exactly one way in: creator upload. Podcasts are
 * the exception — a show's rows are a MIRROR of somebody else's feed, and every
 * crawl overwrites them. That is why the `$set`/`$setOnInsert` split matters so
 * much here and is preserved so carefully below: the insert half carries what
 * SYRA owns about the show (`source`, `status`, `claimable`) and must survive
 * every refresh, while the set half is whatever the feed last said.
 *
 * ## What the port changed, and what it did not
 *
 * The show and its categories, funding links and credits were one document and
 * are five tables; `db/podcasts/podcasts.ts` runs them as one transaction, so a
 * crawl that dies mid-write no longer leaves a show carrying the previous
 * refresh's hosts. The `image`/`imageSizes` pair became an `image_assets` id
 * plus six variant FKs, so {@link showCoverColumns} converts once rather than at
 * each of the two call sites that used to assign them.
 *
 * The one thing that genuinely could not be preserved: Mongo reported a real
 * insert through `lastErrorObject.updatedExisting`, which has no equivalent.
 * `upsertEpisodeFromFeed` answers it from `xmax = 0` on the returned row instead
 * — exact, and unlike the Mongo form it is correct under two concurrent crawls
 * of the same feed.
 */

import type { CatalogImageSizes } from '@syra/shared-types';
import {
  findPodcastByFeedUrl,
  findPodcastByGuid,
  setPodcastRefreshState,
  updatePodcast,
  upsertPodcastFromFeed,
  type PodcastValues,
} from '../../db/podcasts/podcasts';
import {
  episodeExists,
  episodeStats,
  upsertEpisodeFromFeed,
  type EpisodeValues,
} from '../../db/podcasts/episodes';
import { loadImageVariants } from '../../db/catalog/hydrate';
import { podcastArtwork, type PodcastRow } from '../../db/podcasts/serialize';
import { podcastImageIds } from '../../db/podcasts/serialize';
import {
  notifySubscribersOfNewEpisode,
  type PublishedEpisode,
} from '../notifications/triggers/episodePublished';
import { logger } from '../../utils/logger';
import { fetchAndParse, type ParsedEpisode, type ParsedShow, type SafeFetchFn } from './RssConnector';
import { rehostPodcastImage } from './podcastMedia';
import type { PodcastDirectoryCandidate } from './PodcastDirectory';

/** Max NEW episodes whose own artwork is re-hosted inline per import (bounds the
 * import path; the long tail is covered by the backfill script). */
const MAX_EPISODE_IMAGE_REHOST = 30;

/**
 * The seven artwork columns a re-host writes, plus the two extracted colors.
 *
 * One shape because the show path and the episode path write the identical set,
 * and because `imageSizes.small?.id ?? null` repeated six times in two places is
 * how one of them ends up missing a variant.
 */
interface ArtworkColumns {
  imageId: string | null;
  imageSizesSmallId: string | null;
  imageSizesMediumId: string | null;
  imageSizesLargeId: string | null;
  imageSizesXlargeId: string | null;
  imageSizesXxlargeId: string | null;
  imageSizesOriginalId: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  imageSourceUrl?: string;
}

function artworkColumns(image: string, sizes: CatalogImageSizes): ArtworkColumns {
  return {
    imageId: image,
    imageSizesSmallId: sizes.small?.id ?? null,
    imageSizesMediumId: sizes.medium?.id ?? null,
    imageSizesLargeId: sizes.large?.id ?? null,
    imageSizesXlargeId: sizes.xlarge?.id ?? null,
    imageSizesXxlargeId: sizes.xxlarge?.id ?? null,
    imageSizesOriginalId: sizes.original?.id ?? null,
  };
}

export interface ImportFeedOptions {
  /** Bypass conditional GET (always re-parse the body). */
  force?: boolean;
  /** Directory metadata to enrich the show (podcastIndexId, appleCollectionId, …). */
  directory?: PodcastDirectoryCandidate;
  /** Injectable SSRF-safe fetch (defaults to the real `safeFetch`). For tests. */
  fetch?: SafeFetchFn;
}

export interface ImportFeedResult {
  podcast: PodcastRow;
  notModified: boolean;
  importedEpisodes: number;
  failedEpisodes: number;
}

/**
 * The show columns a refresh overwrites.
 *
 * `image`/`imageSizes`/colors are NOT here — they are handled by the re-host
 * step after the upsert, because we never store an external URL in the image
 * columns and the re-host needs the row's existing id to be idempotent.
 */
function buildPodcastSet(
  show: ParsedShow,
  directory: PodcastDirectoryCandidate | undefined
): PodcastValues {
  return {
    title: show.title,
    description: show.description,
    author: show.author ?? directory?.author,
    language: show.language,
    explicit: show.explicit,
    link: show.link,
    type: show.type,
    podcastGuid: show.podcastGuid,
    podcastIndexId: directory?.podcastIndexId,
    appleCollectionId: directory?.appleCollectionId,
  };
}

/** The episode columns a refresh overwrites. */
function buildEpisodeSet(
  podcastTitle: string,
  episode: ParsedEpisode,
  artwork: ArtworkColumns | undefined
): EpisodeValues {
  return {
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
    chaptersUrl: episode.chapters?.url,
    chaptersType: episode.chapters?.type,
    ...(artwork ?? {}),
    // `pubDate` is set here only when parsed; the insert fallback handles the rest.
    ...(episode.pubDate ? { pubDate: episode.pubDate } : {}),
  };
}

/**
 * Re-host the show cover into Syra S3 and return the columns to write, keeping
 * the external URL only as a fallback.
 *
 * Returns the columns rather than mutating a document, which is what the Mongo
 * version did. Colors follow the catalog convention: REPLACE when the image
 * changed, fill-missing when it did not — `rehostPodcastImage` returns no colors
 * on the idempotent path, so blindly assigning would erase them.
 */
async function showCoverColumns(
  row: PodcastRow,
  feedUrl: string,
  sourceImageUrl: string | undefined
): Promise<ArtworkColumns | undefined> {
  if (!sourceImageUrl) return undefined;

  // The existing variants, so an unchanged cover is recognised rather than
  // re-downloaded — this is what `rehostPodcastImage`'s idempotent path needs.
  const lookup = await loadImageVariants(podcastImageIds(row));
  const existing = podcastArtwork(row, lookup);

  const rehosted = await rehostPodcastImage(sourceImageUrl, {
    source: 'rss',
    entityType: 'podcast',
    externalId: row.podcastGuid ?? feedUrl,
    existingImageId: row.imageId ?? undefined,
    existingImageSizes: existing.imageSizes,
  });

  // Keep the external artwork URL as a fallback regardless of re-host outcome.
  if (!rehosted) {
    return {
      imageId: row.imageId,
      imageSizesSmallId: row.imageSizesSmallId,
      imageSizesMediumId: row.imageSizesMediumId,
      imageSizesLargeId: row.imageSizesLargeId,
      imageSizesXlargeId: row.imageSizesXlargeId,
      imageSizesXxlargeId: row.imageSizesXxlargeId,
      imageSizesOriginalId: row.imageSizesOriginalId,
      imageSourceUrl: sourceImageUrl,
    };
  }

  const columns = artworkColumns(rehosted.image, rehosted.imageSizes);
  columns.imageSourceUrl = sourceImageUrl;

  if (rehosted.image !== row.imageId) {
    // Replaced: the new cover's colors win, including clearing them when the
    // extractor returned none.
    columns.primaryColor = rehosted.primaryColor ?? null;
    columns.secondaryColor = rehosted.secondaryColor ?? null;
  } else {
    // Unchanged: fill only what is missing.
    if (rehosted.primaryColor && !row.primaryColor) columns.primaryColor = rehosted.primaryColor;
    if (rehosted.secondaryColor && !row.secondaryColor) {
      columns.secondaryColor = rehosted.secondaryColor;
    }
  }

  return columns;
}

/**
 * Fetch a feed and mirror it into the catalog. Idempotent: re-running upserts
 * the same show/episodes. Returns the (possibly unchanged) podcast plus counts.
 */
export async function importFeed(
  feedUrl: string,
  options: ImportFeedOptions = {}
): Promise<ImportFeedResult> {
  const existing =
    (await findPodcastByFeedUrl(feedUrl)) ??
    (options.directory?.podcastGuid
      ? await findPodcastByGuid(options.directory.podcastGuid)
      : undefined);

  const fetched = await fetchAndParse(
    feedUrl,
    {
      etag: options.force ? undefined : (existing?.etag ?? undefined),
      lastModified: options.force ? undefined : (existing?.lastModified ?? undefined),
    },
    { fetch: options.fetch }
  );

  if (fetched.notModified && existing) {
    await setPodcastRefreshState(existing.id, {
      lastRefreshedAt: new Date(),
      needsDeepImport: false,
    });
    return {
      podcast: { ...existing, lastRefreshedAt: new Date(), needsDeepImport: false },
      notModified: true,
      importedEpisodes: 0,
      failedEpisodes: 0,
    };
  }

  if (!fetched.show || !fetched.episodes) {
    throw new Error(`podcastImportService: empty parse result for ${feedUrl}`);
  }

  const show = fetched.show;
  const set = buildPodcastSet(show, options.directory);
  const categories = show.categories.length > 0 ? show.categories : (options.directory?.categories ?? []);

  let podcast = await upsertPodcastFromFeed({
    existingId: existing?.id,
    set,
    insert: {
      ...set,
      // `set` cannot supply these two: `title` is `NOT NULL` and comes from the
      // parse, `source` is `NOT NULL` and is Syra's own classification.
      title: show.title,
      feedUrl,
      source: 'rss',
      status: 'active',
      claimable: true,
    },
    children: { categories, funding: show.funding, persons: show.persons },
  });

  /**
   * Re-host the show cover and PERSIST it IMMEDIATELY — before the
   * (potentially slow, 2000-episode) loop — so the Syra-hosted image id,
   * variants and colors replace the external URL fast. The external URL is kept
   * only in `image_source_url` as a fallback.
   */
  const showImageUrl = show.image ?? options.directory?.image;
  try {
    const cover = await showCoverColumns(podcast, feedUrl, showImageUrl);
    if (cover) podcast = (await updatePodcast(podcast.id, cover)) ?? podcast;
  } catch (err) {
    logger.warn('[podcasts] show cover re-host failed', { feedUrl, err });
    if (showImageUrl) {
      await updatePodcast(podcast.id, { imageSourceUrl: showImageUrl }).catch((saveErr) =>
        logger.warn('[podcasts] persisting fallback image url failed', { feedUrl, err: saveErr })
      );
    }
  }

  let importedEpisodes = 0;
  let failedEpisodes = 0;
  /** Episodes this run actually INSERTED — the only ones worth notifying about. */
  const newlyPublished: PublishedEpisode[] = [];
  let rehostedEpisodeImages = 0;

  for (const episode of fetched.episodes) {
    try {
      // Re-host a NEW episode's OWN artwork (distinct from the show), bounded.
      let artwork: ArtworkColumns | undefined;
      const ownArtUrl = episode.image;
      if (ownArtUrl && ownArtUrl !== showImageUrl) {
        const alreadyExists = await episodeExists(podcast.id, episode.guid);
        if (!alreadyExists) {
          if (rehostedEpisodeImages < MAX_EPISODE_IMAGE_REHOST) {
            const rehosted = await rehostPodcastImage(ownArtUrl, {
              source: 'rss',
              entityType: 'episode',
              externalId: episode.guid,
            });
            if (rehosted) {
              artwork = artworkColumns(rehosted.image, rehosted.imageSizes);
              artwork.primaryColor = rehosted.primaryColor ?? null;
              artwork.secondaryColor = rehosted.secondaryColor ?? null;
              artwork.imageSourceUrl = ownArtUrl;
              rehostedEpisodeImages += 1;
            } else {
              artwork = { ...NO_ARTWORK, imageSourceUrl: ownArtUrl };
            }
          } else {
            // Beyond the per-import cap → keep the external URL as a fallback only.
            artwork = { ...NO_ARTWORK, imageSourceUrl: ownArtUrl };
          }
        }
        // Existing episode → leave its cover as-is (idempotent).
      }

      const episodeSet = buildEpisodeSet(podcast.title, episode, artwork);
      const { row, inserted } = await upsertEpisodeFromFeed({
        insert: {
          ...episodeSet,
          podcastId: podcast.id,
          guid: episode.guid,
          podcastTitle: podcast.title,
          title: episode.title,
          pubDate: episode.pubDate ?? new Date(),
          source: 'rss',
          status: 'ready',
          cacheStatus: 'none',
          playCount: 0,
          popularity: 0,
        },
        set: episodeSet,
        children: { transcripts: episode.transcripts, persons: episode.persons },
      });
      importedEpisodes += 1;

      // `importedEpisodes` counts episodes PROCESSED, so it cannot drive
      // notifications — every refresh re-processes the whole feed. Collected
      // here and fanned out AFTER the import is durable, so notification work
      // never sits in this loop.
      if (inserted) {
        newlyPublished.push({
          episodeId: row.id,
          podcastId: podcast.id,
          podcastTitle: podcast.title,
          episodeTitle: episode.title,
          pubDate: episode.pubDate,
        });
      }
    } catch (err) {
      logger.error('[podcasts] per-episode upsert failed', { feedUrl, guid: episode.guid, err });
      failedEpisodes += 1;
    }
  }

  const stats = await episodeStats(podcast.id);
  await setPodcastRefreshState(podcast.id, {
    episodeCount: stats.total,
    lastEpisodeAt: stats.latestPubDate ?? podcast.lastEpisodeAt,
    lastRefreshedAt: new Date(),
    needsDeepImport: false,
    ...(fetched.etag ? { etag: fetched.etag } : {}),
    ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {}),
  });

  // Fire-and-forget, and explicitly non-fatal: this is the only external ingest
  // Syra has, so a notification problem must never stop podcasts updating.
  // `notifySubscribersOfNewEpisode` already swallows delivery failures; this
  // catch covers the fan-out itself (the subscriber query) so nothing can escape
  // into the import at all.
  for (const published of newlyPublished) {
    try {
      await notifySubscribersOfNewEpisode(published);
    } catch (err) {
      logger.error('[podcasts] episode notification fan-out failed', {
        feedUrl,
        episodeId: published.episodeId,
        err,
      });
    }
  }

  return { podcast, notModified: false, importedEpisodes, failedEpisodes };
}

/**
 * The seven artwork columns, all null — an episode that has its own external art
 * we could not re-host keeps only `image_source_url`.
 *
 * Spelled out rather than `{}` because these columns must be WRITTEN as null on
 * a refresh: leaving them out would preserve whatever a previous crawl stored,
 * which for a cover that has since been removed from the feed is a stale image.
 */
const NO_ARTWORK: ArtworkColumns = {
  imageId: null,
  imageSizesSmallId: null,
  imageSizesMediumId: null,
  imageSizesLargeId: null,
  imageSizesXlargeId: null,
  imageSizesXxlargeId: null,
  imageSizesOriginalId: null,
};
