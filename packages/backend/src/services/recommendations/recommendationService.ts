import { and, arrayOverlaps, eq, inArray, notInArray, or, type SQL } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import { CatalogRelationModel } from '../../models/CatalogRelation';
import { UserTasteProfileModel } from '../../models/UserTasteProfile';
import { ListeningEventModel } from '../../models/ListeningEvent';
import { getDb } from '../../db/postgres';
import { catalogEntities, tracks } from '../../db/schema/catalog';
import { PROTECTED_COLUMNS_BY_TABLE } from '../../db/schema/protectedColumns';
import { notTerminatedArtist, playableTrackFilter } from '../../db/catalog/visibility';
import {
  descNullsLast,
  findArtistsWithPlayableTracks,
  imageFirst,
} from '../../db/catalog/containers';
import type { PublicCatalogEntityRow, PublicTrackRow } from '../../db/catalog/serialize';
import { listMembership } from '../../db/library/membership';
import { orderByIds, rankByTaste, topRelatedArtistIds } from './taste';

/**
 * Read side of the recommendation engine. Every function degrades gracefully:
 * when the collaborative graph (`CatalogRelation`) has no edges yet for an
 * entity (cold start / sparse catalog), it falls back to content similarity
 * (shared genre) and global popularity, so a result is always returned.
 *
 * `CatalogRelation`, `UserTasteProfile` and `ListeningEvent` belong to the user
 * vertical (Task 15) and are still Mongoose. Every one of them is read for a
 * LIST OF IDS that is then looked up in Postgres, never joined to a catalog
 * collection in one pipeline, so the split is a second round trip rather than a
 * broken query. `UserLibrary` was in that list and is not any more — Task 11
 * put the memberships on `db/library/membership.ts`.
 */

const DEFAULT_RELATED_LIMIT = 20;

/**
 * The columns every recommendation surface returns — the FULL public row, not a
 * ranking projection.
 *
 * These were two hand-written column lists (`{ id, artistId, albumId, genre,
 * metadataGenre, isAvailable, popularity, playCount }` and its artist twin),
 * carrying exactly what {@link rankByTaste} and {@link orderByIds} read. That
 * was enough for this file and not enough for its callers: both controllers
 * serialize what comes back, and a row with no `title`, no `artistName` and no
 * cover art cannot be serialized into a `Track`. `GET /api/artists/:id/related`,
 * `/api/tracks/:id/similar`, `/api/recommendations/made-for-you` and
 * `/api/browse/made-for-you` all answered `{"id":"", …}` for exactly that
 * reason — see `db/catalog/__tests__/recommendationDtos.test.ts`.
 *
 * Selecting the public row instead means the result feeds `toTrackDtos` /
 * `toArtistDtos` directly, with no second round trip to re-read the rows the
 * ranking query already touched. `publicColumns()` keeps `tracks.sha256`,
 * `tracks.images`, `catalog_entities.images` and
 * `catalog_entities.imageSuggestions` off the row entirely, so widening the
 * projection does not widen what can reach a client.
 */
const CATALOG_TRACK_COLUMNS = publicColumns(tracks, PROTECTED_COLUMNS_BY_TABLE);
const CATALOG_ARTIST_COLUMNS = publicColumns(catalogEntities, PROTECTED_COLUMNS_BY_TABLE);

// ── Related artists ─────────────────────────────────────────────────────────

/**
 * Drop artists with nothing left to play.
 *
 * Applied to the FINAL list rather than to each source, because all three
 * sources can produce one: the co-listen graph is rewritten on the job's
 * schedule and so outlives takedowns, and both fallbacks exclude only
 * `terminated` — which is a property of the ACCOUNT, not of the catalog. An
 * artist whose every track was taken down individually, or who was created as a
 * claimable stub and has no tracks yet, passes every one of those checks and
 * then opens to an empty page.
 *
 * The list can come back shorter than `limit`. That is the intended trade: a
 * short shelf is honest, a padded one sends listeners to dead ends.
 */
async function withPlayableCatalog(artists: PublicCatalogEntityRow[]): Promise<PublicCatalogEntityRow[]> {
  if (artists.length === 0) return artists;

  const playable = await findArtistsWithPlayableTracks(
    inArray(catalogEntities.id, artists.map((artist) => artist.id)),
    { orderBy: [descNullsLast(catalogEntities.popularity)], limit: artists.length }
  );
  const keep = new Set(playable.map((artist) => artist.id));

  return artists.filter((artist) => keep.has(artist.id));
}

/** Artists by id, in the order the ids were ranked, excluding terminated accounts. */
async function artistsByIds(ids: string[]): Promise<PublicCatalogEntityRow[]> {
  if (ids.length === 0) return [];

  const rows = await getDb()
    .select(CATALOG_ARTIST_COLUMNS)
    .from(catalogEntities)
    .where(and(inArray(catalogEntities.id, ids), notTerminatedArtist()));

  return orderByIds(rows, ids);
}

/**
 * Artists fans of `artistId` also listen to. Primary source is the precomputed
 * co-listen graph; falls back to artists sharing a genre, then to globally
 * popular artists, never returning the seed artist itself.
 *
 * Every path ends in {@link withPlayableCatalog}, so no caller can surface an
 * artist with no playable catalog — this is the single reader of the artist
 * co-listen graph, and both `GET /api/artists/:id/related` and the artist
 * profile page go through it.
 */
export async function getRelatedArtists(
  artistId: string,
  limit = DEFAULT_RELATED_LIMIT
): Promise<PublicCatalogEntityRow[]> {
  const edges = await CatalogRelationModel.find({ kind: 'artist', sourceId: artistId })
    .sort({ score: -1 })
    .limit(limit)
    .lean();

  const relatedIds = edges.map((edge) => edge.targetId);
  const collaborative = await artistsByIds(relatedIds);

  if (collaborative.length >= limit) return withPlayableCatalog(collaborative.slice(0, limit));

  // Content fallback: artists sharing a genre with the seed.
  const [seed] = await getDb()
    .select({ genres: catalogEntities.genres })
    .from(catalogEntities)
    .where(and(eq(catalogEntities.id, artistId), eq(catalogEntities.type, 'artist')))
    .limit(1);

  if (!seed) return withPlayableCatalog(collaborative.slice(0, limit));
  const exclude = new Set<string>([artistId, ...collaborative.map((a) => a.id)]);

  const genreMatches = seed.genres?.length
    ? await getDb()
        .select(CATALOG_ARTIST_COLUMNS)
        .from(catalogEntities)
        .where(
          and(
            notTerminatedArtist(),
            notInArray(catalogEntities.id, [...exclude]),
            // `&&` — array overlap, the direct translation of `{ genres: { $in } }`.
            arrayOverlaps(catalogEntities.genres, seed.genres)
          )
        )
        .orderBy(
          imageFirst(catalogEntities.imageId),
          descNullsLast(catalogEntities.popularity),
          descNullsLast(catalogEntities.statsFollowers)
        )
        .limit(limit - collaborative.length)
    : [];

  genreMatches.forEach((a) => exclude.add(a.id));
  const combined = [...collaborative, ...genreMatches];
  if (combined.length >= limit) return withPlayableCatalog(combined.slice(0, limit));

  // Popularity fallback to fill any remainder.
  const popular = await getDb()
    .select(CATALOG_ARTIST_COLUMNS)
    .from(catalogEntities)
    .where(and(notTerminatedArtist(), notInArray(catalogEntities.id, [...exclude])))
    .orderBy(
      imageFirst(catalogEntities.imageId),
      descNullsLast(catalogEntities.popularity),
      descNullsLast(catalogEntities.statsFollowers)
    )
    .limit(limit - combined.length);

  return withPlayableCatalog([...combined, ...popular].slice(0, limit));
}

// ── Similar tracks ──────────────────────────────────────────────────────────

/** Playable tracks by id, in the order the ids were ranked. */
async function tracksByIds(ids: string[]): Promise<PublicTrackRow[]> {
  if (ids.length === 0) return [];

  const rows = await getDb()
    .select(CATALOG_TRACK_COLUMNS)
    .from(tracks)
    .where(and(inArray(tracks.id, ids), playableTrackFilter()));

  return orderByIds(rows, ids);
}

/**
 * Tracks similar to `trackId`. Co-listen graph first, then same-artist / same
 * genre by popularity. Excludes the seed track.
 */
export async function getSimilarTracks(
  trackId: string,
  limit = DEFAULT_RELATED_LIMIT,
): Promise<PublicTrackRow[]> {
  const edges = await CatalogRelationModel.find({ kind: 'track', sourceId: trackId })
    .sort({ score: -1 })
    .limit(limit)
    .lean();

  const collaborative = await tracksByIds(edges.map((edge) => edge.targetId));
  if (collaborative.length >= limit) return collaborative.slice(0, limit);

  const [seed] = await getDb()
    .select({ genre: tracks.genre, artistId: tracks.artistId })
    .from(tracks)
    .where(and(eq(tracks.id, trackId), playableTrackFilter()))
    .limit(1);

  if (!seed) return collaborative.slice(0, limit);
  const exclude = [trackId, ...collaborative.map((t) => t.id)];

  // Composed with `and()`, so the seed's `or(...)` cannot be clobbered by the
  // playability condition the way spreading two Mongo filter objects could.
  const similarity = seed.genre
    ? or(eq(tracks.genre, seed.genre), eq(tracks.artistId, seed.artistId))
    : eq(tracks.artistId, seed.artistId);

  const contentMatches = await getDb()
    .select(CATALOG_TRACK_COLUMNS)
    .from(tracks)
    .where(and(playableTrackFilter(), notInArray(tracks.id, exclude), similarity))
    .orderBy(imageFirst(tracks.coverArtId), descNullsLast(tracks.popularity), descNullsLast(tracks.playCount))
    .limit(limit - collaborative.length);

  return [...collaborative, ...contentMatches].slice(0, limit);
}

// ── Personalised "Made For You" ──────────────────────────────────────────────

export interface MadeForYou {
  tracks: PublicTrackRow[];
  artists: PublicCatalogEntityRow[];
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
  const [profile, likedTracks, followedArtists] = await Promise.all([
    UserTasteProfileModel.findOne({ oxyUserId }).lean(),
    listMembership('likedTracks', oxyUserId),
    listMembership('followedArtists', oxyUserId),
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
    const [coldTracks, coldArtists] = await Promise.all([
      getDb()
        .select(CATALOG_TRACK_COLUMNS)
        .from(tracks)
        .where(playableTrackFilter())
        .orderBy(
          imageFirst(tracks.coverArtId),
          descNullsLast(tracks.popularity),
          descNullsLast(tracks.playCount),
          descNullsLast(tracks.createdAt)
        )
        .limit(limit),
      getDb()
        .select(CATALOG_ARTIST_COLUMNS)
        .from(catalogEntities)
        .where(notTerminatedArtist())
        .orderBy(
          imageFirst(catalogEntities.imageId),
          descNullsLast(catalogEntities.popularity),
          descNullsLast(catalogEntities.statsFollowers)
        )
        .limit(limit),
    ]);
    return { tracks: coldTracks, artists: coldArtists, personalized: false };
  }

  // Exclude recently-played and already-liked tracks from track recs.
  const recentEvents = await ListeningEventModel.find({ oxyUserId })
    .sort({ playedAt: -1 })
    .limit(200)
    .select({ trackId: 1 })
    .lean();
  const excludeTrackIds = [
    ...new Set<string>([
      ...recentEvents.map((e) => e.trackId),
      ...likedTracks,
    ]),
  ];

  // Discover NEW tracks: by the user's favourite artists (deep cuts they may not
  // have heard) and by their favourite genres, ranked by global popularity.
  const affinity = affinityCondition(topArtists, topGenres);
  const candidateTracks = await getDb()
    .select(CATALOG_TRACK_COLUMNS)
    .from(tracks)
    .where(
      and(
        playableTrackFilter(),
        excludeTrackIds.length > 0 ? notInArray(tracks.id, excludeTrackIds) : undefined,
        affinity
      )
    )
    .orderBy(imageFirst(tracks.coverArtId), descNullsLast(tracks.popularity), descNullsLast(tracks.playCount))
    .limit(limit * 3);

  // Re-rank candidates by taste affinity so the user's strongest genres/artists
  // surface first, not just whatever is globally most popular within the filter.
  const ranked = rankByTaste(candidateTracks, profile?.genres ?? [], profile?.artists ?? []).slice(
    0,
    limit
  );

  // Artists: related to the user's top artists (collaborative graph), excluding
  // ones they already follow, blended with their genre affinity.
  const followed = new Set<string>(followedArtists);
  followed.add('');
  const relatedArtistIds = await topRelatedArtistIds(topArtists, followed, limit * 2);

  let artists = await artistsByIds(relatedArtistIds);

  if (artists.length < limit && topGenres.length) {
    const exclude = [...new Set<string>([...followed, ...artists.map((a) => a.id)])].filter(
      (id) => id.length > 0
    );
    const genreArtists = await getDb()
      .select(CATALOG_ARTIST_COLUMNS)
      .from(catalogEntities)
      .where(
        and(
          notTerminatedArtist(),
          exclude.length > 0 ? notInArray(catalogEntities.id, exclude) : undefined,
          arrayOverlaps(catalogEntities.genres, topGenres)
        )
      )
      .orderBy(
        imageFirst(catalogEntities.imageId),
        descNullsLast(catalogEntities.popularity),
        descNullsLast(catalogEntities.statsFollowers)
      )
      .limit(limit - artists.length);
    artists = [...artists, ...genreArtists];
  }

  return { tracks: ranked, artists: artists.slice(0, limit), personalized: true };
}

/**
 * "By an artist you like, OR in a genre you like" — or nothing, when the profile
 * named neither.
 *
 * Returning `undefined` rather than an always-true condition is what keeps the
 * `and()` above free of a term the planner would have to evaluate; drizzle drops
 * an undefined operand.
 */
function affinityCondition(topArtists: string[], topGenres: string[]): SQL | undefined {
  const terms: SQL[] = [];
  if (topArtists.length > 0) terms.push(inArray(tracks.artistId, topArtists));
  if (topGenres.length > 0) terms.push(inArray(tracks.genre, topGenres));
  if (terms.length === 0) return undefined;
  return terms.length === 1 ? terms[0] : (or(...terms) as SQL);
}
