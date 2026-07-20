import mongoose from 'mongoose';
import { CatalogRelationModel } from '../../models/CatalogRelation';
import type { ITrack } from '../../models/Track';

/**
 * Taste and relatedness primitives shared by every personalised read.
 *
 * These four helpers are the common vocabulary of the recommendation layer and
 * the radio candidate pools: how filters compose, how the collaborative graph is
 * folded across several seeds, how a candidate set is re-ranked by taste, and
 * how `$in` results are put back into the order that was asked for. They live
 * here — not duplicated per consumer — because a divergence between two copies
 * would silently change what a listener is recommended depending on which
 * surface they came from.
 */

/**
 * Compose filters under `$and` rather than by spreading them together.
 *
 * Spreading is what silently drops an `$or`: a later key of the same name wins,
 * so a playability `$or` merged with a content `$or` yields only the second.
 * Empty filters are dropped so the result stays as flat as possible and the
 * planner can still use a leading indexed field.
 */
export function andMongoFilters(
  ...filters: Array<mongoose.QueryFilter<ITrack>>
): mongoose.QueryFilter<ITrack> {
  const nonEmptyFilters = filters.filter((filter) => Object.keys(filter).length > 0);
  if (nonEmptyFilters.length === 0) {
    return {};
  }
  if (nonEmptyFilters.length === 1) {
    return nonEmptyFilters[0];
  }
  return { $and: nonEmptyFilters };
}

/** Resolve the union of related-artist edges for a set of seed artists. */
export async function topRelatedArtistIds(
  seedArtistIds: string[],
  exclude: Set<string>,
  limit: number,
): Promise<string[]> {
  if (seedArtistIds.length === 0) return [];

  const edges = await CatalogRelationModel.find({
    kind: 'artist',
    sourceId: { $in: seedArtistIds },
  })
    .sort({ score: -1 })
    .limit(limit * 3)
    .lean();

  // Sum scores across seeds so an artist related to several of the user's
  // favourites ranks higher than one related to a single favourite.
  const scoreById = new Map<string, number>();
  for (const edge of edges) {
    if (exclude.has(edge.targetId)) continue;
    if (seedArtistIds.includes(edge.targetId)) continue;
    scoreById.set(edge.targetId, (scoreById.get(edge.targetId) ?? 0) + edge.score);
  }

  return Array.from(scoreById.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id)
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
}

/** The track fields {@link rankByTaste} reads. */
export interface TasteRankableTrack {
  artistId: string;
  genre?: string;
  popularity?: number;
}

/**
 * Re-rank tracks by a blend of taste affinity (genre + artist weight) and a
 * mild global-popularity prior, so personalisation dominates but quality still
 * matters within the user's taste.
 */
export function rankByTaste<T extends TasteRankableTrack>(
  tracks: T[],
  genreWeights: { key: string; weight: number }[],
  artistWeights: { key: string; weight: number }[],
): T[] {
  const genreMap = new Map(genreWeights.map((g) => [g.key, g.weight]));
  const artistMap = new Map(artistWeights.map((a) => [a.key, a.weight]));
  const maxGenre = Math.max(1, ...genreWeights.map((g) => g.weight));
  const maxArtist = Math.max(1, ...artistWeights.map((a) => a.weight));

  return [...tracks].sort((a, b) => taste(b) - taste(a));

  function taste(track: T): number {
    const genre = track.genre?.trim().toLowerCase();
    const genreAffinity = genre ? (genreMap.get(genre) ?? 0) / maxGenre : 0;
    const artistAffinity = (artistMap.get(track.artistId) ?? 0) / maxArtist;
    const popularityPrior = (track.popularity ?? 0) / 100;
    return 0.5 * artistAffinity + 0.35 * genreAffinity + 0.15 * popularityPrior;
  }
}

/** Re-order documents to match a list of ids (Mongo `$in` ignores order). */
export function orderByIds<T extends { _id: mongoose.Types.ObjectId }>(docs: T[], ids: string[]): T[] {
  const index = new Map(ids.map((id, i) => [id, i]));
  return docs
    .filter((doc) => index.has(doc._id.toString()))
    .sort((a, b) => (index.get(a._id.toString()) ?? 0) - (index.get(b._id.toString()) ?? 0));
}
