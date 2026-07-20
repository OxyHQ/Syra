import mongoose from 'mongoose';
import { TrackModel, type ITrack } from '../../models/Track';
import { ArtistModel } from '../../models/CatalogEntity';
import { CatalogRelationModel } from '../../models/CatalogRelation';
import { UserTasteProfileModel } from '../../models/UserTasteProfile';
import { UserLibraryModel } from '../../models/Library';
import { ListeningEventModel } from '../../models/ListeningEvent';
import { withImageFirstSort } from '../../utils/imageFirstSort';
import {
  playableTrackFilter,
} from '../../utils/catalogVisibility';
import { andMongoFilters, orderByIds, rankByTaste, topRelatedArtistIds } from './taste';

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
    ? orderByIds(await ArtistModel.find({ _id: { $in: relatedIds }, terminated: { $ne: true } }).lean(), relatedIds)
    : [];

  if (collaborative.length >= limit) return collaborative.slice(0, limit);

  // Content fallback: artists sharing a genre with the seed.
  const seed = await ArtistModel.findOne({ _id: artistId }).select({ genres: 1 }).lean();
  if (!seed) return collaborative.slice(0, limit);
  const exclude = new Set<string>([artistId, ...collaborative.map((a) => a._id.toString())]);

  const genreMatches = seed?.genres?.length
    ? await ArtistModel.find({
        _id: { $nin: Array.from(exclude).filter((id) => mongoose.Types.ObjectId.isValid(id)) },
        genres: { $in: seed.genres },
        terminated: { $ne: true },
      })
        .sort(withImageFirstSort('artist', { popularity: -1, 'stats.followers': -1 }))
        .limit(limit - collaborative.length)
        .lean()
    : [];

  genreMatches.forEach((a) => exclude.add(a._id.toString()));
  const combined = [...collaborative, ...genreMatches];
  if (combined.length >= limit) return combined.slice(0, limit);

  // Popularity fallback to fill any remainder.
  const popular = await ArtistModel.find({
    _id: { $nin: Array.from(exclude).filter((id) => mongoose.Types.ObjectId.isValid(id)) },
    terminated: { $ne: true },
  })
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
export async function getSimilarTracks(
  trackId: string,
  limit = DEFAULT_RELATED_LIMIT,
): Promise<CatalogTrack[]> {
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

  const contentBaseFilter = playableTrackFilter<ITrack>({
    _id: { $nin: Array.from(exclude).filter((id) => mongoose.Types.ObjectId.isValid(id)) },
  });
  let contentFilter: mongoose.QueryFilter<ITrack> = contentBaseFilter;
  if (seed?.genre) {
    contentFilter = andMongoFilters(contentBaseFilter, { $or: [{ genre: seed.genre }, { artistId: seed.artistId }] });
  } else if (seed?.artistId) {
    contentFilter = andMongoFilters(contentBaseFilter, { artistId: seed.artistId });
  }

  const contentMatches = await TrackModel.find(contentFilter)
    .sort(withImageFirstSort('track', { popularity: -1, playCount: -1 }))
    .limit(limit - collaborative.length)
    .lean();

  return [...collaborative, ...contentMatches].slice(0, limit);
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
export async function getMadeForYou(
  oxyUserId: string,
  limit = 20,
): Promise<MadeForYou> {
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
      TrackModel.find(playableTrackFilter({}))
        .sort(withImageFirstSort('track', { popularity: -1, playCount: -1, createdAt: -1 }))
        .limit(limit)
        .lean(),
      ArtistModel.find({ terminated: { $ne: true } })
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
  const baseTrackFilter = playableTrackFilter<CatalogTrack>({
    _id: { $nin: excludeTrackObjectIds },
  });
  const trackOr: mongoose.QueryFilter<ITrack>[] = [];
  if (validTopArtists.length) trackOr.push({ artistId: { $in: validTopArtists } });
  if (topGenres.length) trackOr.push({ genre: { $in: topGenres } });
  const trackFilter = trackOr.length
    ? andMongoFilters(baseTrackFilter, { $or: trackOr })
    : baseTrackFilter;

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
      await ArtistModel.find({ _id: { $in: relatedArtistIds }, terminated: { $ne: true } }).lean(),
      relatedArtistIds,
    );
  }
  if (artists.length < limit && topGenres.length) {
    const exclude = new Set<string>([...followed, ...artists.map((a) => a._id.toString())]);
    const genreArtists = await ArtistModel.find({
      _id: { $nin: Array.from(exclude).filter((id) => mongoose.Types.ObjectId.isValid(id)) },
      genres: { $in: topGenres },
      terminated: { $ne: true },
    })
      .sort(withImageFirstSort('artist', { popularity: -1, 'stats.followers': -1 }))
      .limit(limit - artists.length)
      .lean();
    artists = [...artists, ...genreArtists];
  }

  return { tracks, artists: artists.slice(0, limit), personalized: true };
}

