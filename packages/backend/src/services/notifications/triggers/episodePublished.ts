import { UserLibraryModel } from '../../../models/Library';
import { notifyUser, type NotifierDeps } from '../notifier';

/**
 * Trigger: a subscribed show published a new episode.
 *
 * Two suppression layers apply, and they solve different problems:
 *
 *  - The AGE GATE here. A feed import surfaces a show's entire back catalogue as "new to
 *    Syra", but a five-year-old episode is not news to a subscriber. Only episodes actually
 *    published recently are worth a notification, so importing a 400-episode archive
 *    notifies nobody about anything old.
 *  - COALESCING in the notifier. Among episodes that DO pass the age gate, a show that
 *    drops three at once still produces one notification per subscriber.
 *
 * Without the age gate, coalescing alone would still fire one push per subscriber for a
 * decade-old archive import — quieter, but still wrong.
 */

/** Episodes older than this are treated as backfill and never notified about. */
export const EPISODE_NOTIFY_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export interface PublishedEpisode {
  episodeId: string;
  podcastId: string;
  podcastTitle: string;
  episodeTitle: string;
  pubDate?: Date;
}

/** Result counts, returned so the import path can log what a refresh actually notified. */
export interface EpisodeNotifyOutcome {
  notified: number;
  skippedAsBackfill: boolean;
}

/**
 * Notify every subscriber of the show. Never throws — the notifier swallows delivery
 * failures, and a refresh must not fail because notifications did.
 */
export async function notifySubscribersOfNewEpisode(
  episode: PublishedEpisode,
  now: number = Date.now(),
  deps?: NotifierDeps,
): Promise<EpisodeNotifyOutcome> {
  if (isBackfill(episode.pubDate, now)) {
    return { notified: 0, skippedAsBackfill: true };
  }

  const subscribers = await UserLibraryModel.find({ subscribedPodcasts: episode.podcastId })
    .select('oxyUserId')
    .lean();

  let notified = 0;
  for (const subscriber of subscribers) {
    const result = await notifyUser({
      recipientId: subscriber.oxyUserId,
      actorId: episode.podcastId,
      event: 'episode.published',
      entityId: episode.episodeId,
      entityType: 'episode',
      title: episode.podcastTitle,
      message: episode.episodeTitle,
      data: { podcastId: episode.podcastId, episodeId: episode.episodeId },
      // One notification per show per subscriber per window, however many episodes land.
      coalesceGroupId: episode.podcastId,
    }, deps);
    if (result.emitted) {
      notified += 1;
    }
  }

  return { notified, skippedAsBackfill: false };
}

/** An episode with no publish date is treated as backfill — unknown age is not news. */
function isBackfill(pubDate: Date | undefined, now: number): boolean {
  if (!pubDate) {
    return true;
  }
  return now - pubDate.getTime() > EPISODE_NOTIFY_MAX_AGE_MS;
}
