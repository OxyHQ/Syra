/**
 * Parent-show artwork resolution for episodes.
 *
 * An episode that carries no cover art of its own inherits its show's artwork
 * in the serialized DTO (see `serializeEpisode`). These helpers fetch only the
 * artwork bundle from the parent podcast(s): a single `findById` for one
 * episode, and a single `$in` query for a batch — never one query per episode.
 */

import mongoose from 'mongoose';
import { PodcastModel } from '../../models/Podcast';
import type { PodcastArtwork } from './podcastSerializers';

/**
 * Mongo projection selecting only the shared artwork bundle inherited by
 * cover-less episodes (re-hosted image + size variants + external source URL +
 * extracted gradient colors).
 */
export const PODCAST_ARTWORK_PROJECTION = 'image imageSizes imageSourceUrl primaryColor secondaryColor';

/**
 * Batch-load the parent-show artwork for a set of episodes. Issues ONE `$in`
 * query over the DISTINCT parent podcast ids, never one query per episode.
 * Returns a map keyed by podcast id string; episodes whose show is missing get
 * no inherited artwork (their own absent cover is left unchanged).
 */
export async function loadShowArtworkByPodcastId(
  episodes: ReadonlyArray<{ podcastId: mongoose.Types.ObjectId }>,
): Promise<Map<string, PodcastArtwork>> {
  const podcastIds = [...new Set(episodes.map((episode) => episode.podcastId.toString()))];
  if (podcastIds.length === 0) return new Map<string, PodcastArtwork>();

  const podcasts = await PodcastModel.find({ _id: { $in: podcastIds } })
    .select(PODCAST_ARTWORK_PROJECTION)
    .lean();

  return new Map<string, PodcastArtwork>(
    podcasts.map((podcast) => [
      podcast._id.toString(),
      {
        image: podcast.image,
        imageSizes: podcast.imageSizes,
        imageSourceUrl: podcast.imageSourceUrl,
        primaryColor: podcast.primaryColor,
        secondaryColor: podcast.secondaryColor,
      },
    ]),
  );
}
