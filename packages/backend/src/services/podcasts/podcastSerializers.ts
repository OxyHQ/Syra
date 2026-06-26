/**
 * API serializers for podcasts and episodes.
 *
 * The catalog's `toApiFormat` only handles `_id`→`id` and createdAt/updatedAt.
 * Podcasts/episodes additionally carry ObjectId refs (`linkedArtistId`,
 * `podcastId`) and extra Date fields (`pubDate`, `lastEpisodeAt`, …) that must
 * become strings/ISO at the API boundary so the frontend's Zod contracts parse.
 *
 * Inputs accept either a hydrated Mongoose document or a `.lean<IPodcast>()` /
 * `.lean<IEpisode>()` result (both typed by the model interface).
 */

import mongoose from 'mongoose';
import type { Podcast, Episode } from '@syra/shared-types';

/**
 * Data-only persisted shapes — the model interface without the Mongoose
 * `Document` mixin. Both a hydrated document and a `.lean()` result are
 * assignable to these, so the serializers accept either without fighting
 * `FlattenMaps` / Document-internal type mismatches.
 */
export type PodcastDocument = Omit<
  Podcast,
  'id' | '_id' | 'createdAt' | 'updatedAt' | 'lastRefreshedAt' | 'lastEpisodeAt' | 'linkedArtistId'
> & {
  _id: mongoose.Types.ObjectId;
  linkedArtistId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  lastRefreshedAt?: Date;
  lastEpisodeAt?: Date;
};

export type EpisodeDocument = Omit<
  Episode,
  'id' | '_id' | 'createdAt' | 'updatedAt' | 'podcastId' | 'pubDate' | 'cache'
> & {
  _id: mongoose.Types.ObjectId;
  podcastId: mongoose.Types.ObjectId;
  pubDate: Date;
  createdAt: Date;
  updatedAt: Date;
  cache?: { status: 'none' | 'cached' | 'hls'; s3Key?: string; hlsMasterKey?: string; cachedAt?: Date };
};

function isoOrUndefined(value: Date | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

export function serializePodcast(doc: PodcastDocument): Podcast {
  return {
    id: doc._id.toString(),
    title: doc.title,
    description: doc.description,
    author: doc.author,
    image: doc.image,
    imageSizes: doc.imageSizes,
    language: doc.language,
    categories: doc.categories,
    explicit: doc.explicit ?? false,
    link: doc.link,
    type: doc.type ?? 'episodic',
    feedUrl: doc.feedUrl,
    podcastGuid: doc.podcastGuid,
    podcastIndexId: doc.podcastIndexId,
    appleCollectionId: doc.appleCollectionId,
    source: doc.source,
    ownerOxyUserId: doc.ownerOxyUserId,
    claimable: doc.claimable,
    claimedByOxyUserId: doc.claimedByOxyUserId,
    linkedArtistId: doc.linkedArtistId ? doc.linkedArtistId.toString() : undefined,
    lastRefreshedAt: isoOrUndefined(doc.lastRefreshedAt),
    refreshIntervalMin: doc.refreshIntervalMin ?? 60,
    etag: doc.etag,
    lastModified: doc.lastModified,
    episodeCount: doc.episodeCount ?? 0,
    lastEpisodeAt: isoOrUndefined(doc.lastEpisodeAt),
    popularity: doc.popularity,
    subscriberCount: doc.subscriberCount,
    status: doc.status ?? 'active',
    funding: doc.funding,
    value: doc.value,
    sources: doc.sources,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function serializeEpisode(doc: EpisodeDocument): Episode {
  return {
    id: doc._id.toString(),
    podcastId: doc.podcastId.toString(),
    podcastTitle: doc.podcastTitle,
    title: doc.title,
    description: doc.description,
    summary: doc.summary,
    guid: doc.guid,
    enclosureUrl: doc.enclosureUrl,
    enclosureType: doc.enclosureType,
    enclosureLength: doc.enclosureLength,
    duration: doc.duration ?? 0,
    pubDate: doc.pubDate.toISOString(),
    season: doc.season,
    episodeNumber: doc.episodeNumber,
    episodeType: doc.episodeType ?? 'full',
    image: doc.image,
    imageSizes: doc.imageSizes,
    explicit: doc.explicit ?? false,
    chapters: doc.chapters,
    transcripts: doc.transcripts,
    persons: doc.persons,
    source: doc.source,
    cache: doc.cache
      ? {
          status: doc.cache.status,
          s3Key: doc.cache.s3Key,
          hlsMasterKey: doc.cache.hlsMasterKey,
          cachedAt: isoOrUndefined(doc.cache.cachedAt),
        }
      : undefined,
    audioSource: doc.audioSource,
    hls: doc.hls,
    hlsMasterKey: doc.hlsMasterKey,
    playCount: doc.playCount,
    popularity: doc.popularity,
    status: doc.status ?? 'ready',
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
