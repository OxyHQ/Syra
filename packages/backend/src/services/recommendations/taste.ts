import { CatalogRelationModel } from '../../models/CatalogRelation';

/**
 * Taste and relatedness primitives shared by every personalised read.
 *
 * These three helpers are the common vocabulary of the recommendation layer and
 * the radio candidate pools: how the collaborative graph is folded across
 * several seeds, how a candidate set is re-ranked by taste, and how an
 * `IN (…)` result is put back into the order that was asked for. They live
 * here — not duplicated per consumer — because a divergence between two copies
 * would silently change what a listener is recommended depending on which
 * surface they came from.
 *
 * `andMongoFilters` is GONE, not ported. It existed because spreading two Mongo
 * filter objects together silently dropped an `$or` — a later key of the same
 * name won. Drizzle composes with `and()`, which cannot lose a term, so there is
 * nothing for a counterpart to do.
 *
 * `CatalogRelation` belongs to the user/recommendations vertical (Task 15) and
 * is still Mongoose here. That is the one thing in this file not yet on
 * Postgres, and it is deliberate: the collaborative graph is another task's
 * table, and the edges it returns are plain string ids either way.
 */

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

  // No id-shape filter: `catalog_entities.id` is `text`, so an edge pointing at
  // an id that does not exist simply matches no row when the caller looks it up.
  // The Mongo version had to drop non-ObjectId ids here or the `$in` would throw.
  return Array.from(scoreById.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

/** The track fields {@link rankByTaste} reads. */
export interface TasteRankableTrack {
  artistId: string;
  genre?: string | null;
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

/**
 * Re-order rows to match a list of ids.
 *
 * `WHERE id IN (…)` has no more defined order than Mongo's `$in` did, and the
 * ids arrive ranked — by collaborative score, by radio pool weight — so
 * returning them in whatever order the planner produced would discard the whole
 * ranking the caller just computed.
 */
export function orderByIds<T extends { id: string }>(rows: T[], ids: string[]): T[] {
  const index = new Map(ids.map((id, i) => [id, i]));
  return rows
    .filter((row) => index.has(row.id))
    .sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
}
