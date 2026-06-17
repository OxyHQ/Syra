import mongoose from 'mongoose';
import { TrackModel } from '../../models/Track';
import { ArtistModel } from '../../models/Artist';
import { CatalogRelationModel } from '../../models/CatalogRelation';
import { UserTasteProfileModel } from '../../models/UserTasteProfile';
import { UserLibraryModel } from '../../models/Library';
import { ListeningEventModel } from '../../models/ListeningEvent';
import { withImageFirstSort } from '../../utils/imageFirstSort';
import { playableTrackFilter, visibleCatalogFilter } from '../../utils/catalogVisibility';

/**
 * Read side of the recommendation engine. Every function degrades gracefully:
 * when the collaborative graph (`CatalogRelation`) has no edges yet for an
 * entity (cold start / sparse catalog), it falls back to content similarity
 * (shared genre) and global popularity, so a result is always returned.
 */

const DEFAULT_RELATED_LIMIT = 20;

interface CatalogTrack {
  _id: mongoose.Types.ObjectId;
  artistId: string;
  albumId?: string;
  genre?: string;
  metadata?: {
    genre?: string[];
  };
  isAvailable?: boolean;
  popularity?: number;
  playCount?: number;
}

interface CatalogArtist {
  _id: mongoose.Types.ObjectId;
  genres?: string[];
  popularity?: number;
  stats?: {
    followers?: number;
  };
  terminated?: boolean;
}

// ── Related artists ─────────────────────────────────────────────────────────

/**
 * Artists fans of `artistId` also listen to. Primary source is the precomputed
 * co-listen graph; falls back to artists sharing a genre, then to globally
 * popular artists, never returning the seed artist itself.
 */
export async function getRelatedArtists(artistId: string, limit = DEFAULT_RELATED_LIMIT): Promise<CatalogArtist[]> {
  if (!mongoose.Types.ObjectId.isValid(artistId)) return [];

  const edges = await CatalogRelationModel.find({ kind: 'artist', sourceId: artistId })
    .sort({ score: -1 })
    .limit(limit)
    .lean();

  const relatedIds = edges
    .map((edge) => edge.targetId)
    .filter((id) => mongoose.Types.ObjectId.isValid(id));

  const collaborative = relatedIds.length
    ? orderByIds(await ArtistModel.find(visibleCatalogFilter({ _id: { $in: relatedIds }, terminated: { $ne: true } })).lean(), relatedIds)
    : [];

  if (collaborative.length >= limit) return collaborative.slice(0, limit);

  // Content fallback: artists sharing a genre with the seed.
  const seed = await ArtistModel.findOne(visibleCatalogFilter({ _id: artistId })).select({ genres: 1 }).lean();
  if (!seed) return collaborative.slice(0, limit);
  const exclude = new Set<string>([artistId, ...collaborative.map((a) => a._id.toString())]);

  const genreMatches = seed?.genres?.length
    ? await ArtistModel.find(visibleCatalogFilter({
        _id: { $nin: Array.from(exclude).filter((id) => mongoose.Types.ObjectId.isValid(id)) },
        genres: { $in: seed.genres },
        terminated: { $ne: true },
      }))
        .sort(withImageFirstSort('artist', { popularity: -1, 'stats.followers': -1 }))
        .limit(limit - collaborative.length)
        .lean()
    : [];

  genreMatches.forEach((a) => exclude.add(a._id.toString()));
  const combined = [...collaborative, ...genreMatches];
  if (combined.length >= limit) return combined.slice(0, limit);

  // Popularity fallback to fill any remainder.
  const popular = await ArtistModel.find(visibleCatalogFilter({
    _id: { $nin: Array.from(exclude).filter((id) => mongoose.Types.ObjectId.isValid(id)) },
    terminated: { $ne: true },
  }))
    .sort(withImageFirstSort('artist', { popularity: -1, 'stats.followers': -1 }))
    .limit(limit - combined.length)
    .lean();

  return [...combined, ...popular].slice(0, limit);
}

// ── Similar tracks ──────────────────────────────────────────────────────────

/**
 * Tracks similar to `trackId`. Co-listen graph first, then same-artist / same
 * genre by popularity. Excludes the seed track.
 */
export async function getSimilarTracks(trackId: string, limit = DEFAULT_RELATED_LIMIT): Promise<CatalogTrack[]> {
  if (!mongoose.Types.ObjectId.isValid(trackId)) return [];

  const edges = await CatalogRelationModel.find({ kind: 'track', sourceId: trackId })
    .sort({ score: -1 })
    .limit(limit)
    .lean();

  const relatedIds = edges
    .map((edge) => edge.targetId)
    .filter((id) => mongoose.Types.ObjectId.isValid(id));

  const collaborative = relatedIds.length
    ? orderByIds(await TrackModel.find(playableTrackFilter({ _id: { $in: relatedIds } })).lean(), relatedIds)
    : [];

  if (collaborative.length >= limit) return collaborative.slice(0, limit);

  const seed = await TrackModel.findOne(playableTrackFilter({ _id: trackId })).select({ genre: 1, artistId: 1 }).lean();
  if (!seed) return collaborative.slice(0, limit);
  const exclude = new Set<string>([trackId, ...collaborative.map((t) => t._id.toString())]);

  const contentFilter: mongoose.FilterQuery<CatalogTrack> = {
    ...playableTrackFilter<CatalogTrack>(),
    _id: { $nin: Array.from(exclude).filter((id) => mongoose.Types.ObjectId.isValid(id)) },
  };
  if (seed?.genre) {
    contentFilter.$or = [{ genre: seed.genre }, { artistId: seed.artistId }];
  } else if (seed?.artistId) {
    contentFilter.artistId = seed.artistId;
  }

  const contentMatches = await TrackModel.find(contentFilter)
    .sort(withImageFirstSort('track', { popularity: -1, playCount: -1 }))
    .limit(limit - collaborative.length)
    .lean();

  return [...collaborative, ...contentMatches].slice(0, limit);
}

// ── Track radio ─────────────────────────────────────────────────────────────

/**
 * A radio station seeded from a track: the seed first, then a deduped blend of
 * its similar tracks and same-genre popular tracks. Suitable for autoplay
 * queue population ("play similar songs" when the queue runs dry).
 */
export async function getTrackRadio(trackId: string, limit = 30): Promise<CatalogTrack[]> {
  if (!mongoose.Types.ObjectId.isValid(trackId)) return [];

  const seed = await TrackModel.findOne(playableTrackFilter({ _id: trackId })).lean();
  if (!seed || seed.isAvailable === false) return [];

  const similar = await getSimilarTracks(trackId, limit * 2);

  const seen = new Set<string>([trackId]);
  const station: CatalogTrack[] = [seed];
  for (const track of similar) {
    const id = track._id.toString();
    if (seen.has(id)) continue;
    seen.add(id);
    station.push(track);
    if (station.length >= limit) break;
  }

  return station.slice(0, limit);
}

// ── Personalised "Made For You" ──────────────────────────────────────────────

export interface MadeForYou {
  tracks: CatalogTrack[];
  artists: CatalogArtist[];
  /** True when the result is personalised from a learned taste profile. */
  personalized: boolean;
}

/**
 * Build a personalised set of tracks + artists for a signed-in user from their
 * learned taste profile, excluding tracks they've already played recently or
 * liked (no point recommending what they already have). When the user has no
 * meaningful taste signal yet (cold start), returns globally popular content
 * flagged `personalized: false` so the caller can label it honestly.
 */
export async function getMadeForYou(oxyUserId: string, limit = 20): Promise<MadeForYou> {
  const [profile, library] = await Promise.all([
    UserTasteProfileModel.findOne({ oxyUserId }).lean(),
    UserLibraryModel.findOne({ oxyUserId }).select({ likedTracks: 1, followedArtists: 1 }).lean(),
  ]);

  const topGenres = (profile?.genres ?? [])
    .filter((g) => g.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
    .map((g) => g.key);

  const topArtists = (profile?.artists ?? [])
    .filter((a) => a.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 15)
    .map((a) => a.key);

  // Cold start: no learned taste → popular content, honestly labelled.
  if (topGenres.length === 0 && topArtists.length === 0) {
    const [tracks, artists] = await Promise.all([
      TrackModel.find(playableTrackFilter())
        .sort(withImageFirstSort('track', { popularity: -1, playCount: -1, createdAt: -1 }))
        .limit(limit)
        .lean(),
      ArtistModel.find(visibleCatalogFilter({ terminated: { $ne: true } }))
        .sort(withImageFirstSort('artist', { popularity: -1, 'stats.followers': -1 }))
        .limit(limit)
        .lean(),
    ]);
    return { tracks, artists, personalized: false };
  }

  // Exclude recently-played and already-liked tracks from track recs.
  const recentEvents = await ListeningEventModel.find({ oxyUserId })
    .sort({ playedAt: -1 })
    .limit(200)
    .select({ trackId: 1 })
    .lean();
  const excludeTrackIds = new Set<string>([
    ...recentEvents.map((e) => e.trackId),
    ...(library?.likedTracks ?? []),
  ]);
  const excludeTrackObjectIds = Array.from(excludeTrackIds).filter((id) => mongoose.Types.ObjectId.isValid(id));

  const validTopArtists = topArtists.filter((id) => mongoose.Types.ObjectId.isValid(id));

  // Discover NEW tracks: by the user's favourite artists (deep cuts they may not
  // have heard) and by their favourite genres, ranked by global popularity.
  const trackFilter: mongoose.FilterQuery<CatalogTrack> = {
    ...playableTrackFilter<CatalogTrack>(),
    _id: { $nin: excludeTrackObjectIds },
  };
  const trackOr: mongoose.FilterQuery<CatalogTrack>[] = [];
  if (validTopArtists.length) trackOr.push({ artistId: { $in: validTopArtists } });
  if (topGenres.length) trackOr.push({ genre: { $in: topGenres } });
  if (trackOr.length) trackFilter.$or = trackOr;

  const candidateTracks = await TrackModel.find(trackFilter)
    .sort(withImageFirstSort('track', { popularity: -1, playCount: -1 }))
    .limit(limit * 3)
    .lean();

  // Re-rank candidates by taste affinity so the user's strongest genres/artists
  // surface first, not just whatever is globally most popular within the filter.
  const tracks = rankByTaste(candidateTracks, profile?.genres ?? [], profile?.artists ?? []).slice(0, limit);

  // Artists: related to the user's top artists (collaborative graph), excluding
  // ones they already follow, blended with their genre affinity.
  const followed = new Set<string>(library?.followedArtists ?? []);
  followed.add('');
  const relatedArtistIds = await topRelatedArtistIds(validTopArtists, followed, limit * 2);

  let artists: CatalogArtist[] = [];
  if (relatedArtistIds.length) {
    artists = orderByIds(
      await ArtistModel.find(visibleCatalogFilter({ _id: { $in: relatedArtistIds }, terminated: { $ne: true } })).lean(),
      relatedArtistIds,
    );
  }
  if (artists.length < limit && topGenres.length) {
    const exclude = new Set<string>([...followed, ...artists.map((a) => a._id.toString())]);
    const genreArtists = await ArtistModel.find(visibleCatalogFilter({
      _id: { $nin: Array.from(exclude).filter((id) => mongoose.Types.ObjectId.isValid(id)) },
      genres: { $in: topGenres },
      terminated: { $ne: true },
    }))
      .sort(withImageFirstSort('artist', { popularity: -1, 'stats.followers': -1 }))
      .limit(limit - artists.length)
      .lean();
    artists = [...artists, ...genreArtists];
  }

  return { tracks, artists: artists.slice(0, limit), personalized: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Resolve the union of related-artist edges for a set of seed artists. */
async function topRelatedArtistIds(
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

/**
 * Re-rank tracks by a blend of taste affinity (genre + artist weight) and a
 * mild global-popularity prior, so personalisation dominates but quality still
 * matters within the user's taste.
 */
function rankByTaste(
  tracks: CatalogTrack[],
  genreWeights: { key: string; weight: number }[],
  artistWeights: { key: string; weight: number }[],
): CatalogTrack[] {
  const genreMap = new Map(genreWeights.map((g) => [g.key, g.weight]));
  const artistMap = new Map(artistWeights.map((a) => [a.key, a.weight]));
  const maxGenre = Math.max(1, ...genreWeights.map((g) => g.weight));
  const maxArtist = Math.max(1, ...artistWeights.map((a) => a.weight));

  return [...tracks].sort((a, b) => taste(b) - taste(a));

  function taste(track: CatalogTrack): number {
    const genre = track.genre?.trim().toLowerCase();
    const genreAffinity = genre ? (genreMap.get(genre) ?? 0) / maxGenre : 0;
    const artistAffinity = (artistMap.get(track.artistId) ?? 0) / maxArtist;
    const popularityPrior = (track.popularity ?? 0) / 100;
    return 0.5 * artistAffinity + 0.35 * genreAffinity + 0.15 * popularityPrior;
  }
}

/** Re-order documents to match a list of ids (Mongo `$in` ignores order). */
function orderByIds<T extends { _id: mongoose.Types.ObjectId }>(docs: T[], ids: string[]): T[] {
  const index = new Map(ids.map((id, i) => [id, i]));
  return docs
    .filter((doc) => index.has(doc._id.toString()))
    .sort((a, b) => (index.get(a._id.toString()) ?? 0) - (index.get(b._id.toString()) ?? 0));
}
