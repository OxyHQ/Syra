import { PodcastModel } from '../models/Podcast';

/**
 * Episode discovery follows the show.
 *
 * When a creator unpublishes a show (`status:'unavailable'`) or the platform removes it
 * (`status:'removed'`), its episodes must also disappear from cross-show surfaces —
 * search and credit listings — otherwise a hidden show's episodes still surface and the
 * show reads as half-hidden. Direct episode links are deliberately NOT affected: a saved
 * link keeps resolving, and show-scoped listings are already gated by the show itself.
 *
 * Implemented as a `podcastId` exclusion rather than a `$lookup` on every episode row:
 * non-active shows are rare, so the id set is small, the extra query uses the indexed
 * `status` field, and result COUNTS stay exact. Post-filtering the page instead would
 * under-fill pages and report totals that disagree with the rows returned.
 */
export async function hiddenShowEpisodeFilter(): Promise<Record<string, unknown>> {
  const hiddenShows = await PodcastModel.find({ status: { $ne: 'active' } })
    .select('_id')
    .lean();

  if (hiddenShows.length === 0) {
    return {};
  }

  return { podcastId: { $nin: hiddenShows.map((show) => show._id) } };
}
