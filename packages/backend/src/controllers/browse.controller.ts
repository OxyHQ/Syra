import { Request, Response, NextFunction } from 'express';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import { PlaylistVisibility } from '@syra/shared-types';
import { getDb, isPostgresConnected } from '../db/postgres';
import { albums, catalogEntities, tracks } from '../db/schema/catalog';
import { playlists } from '../db/schema/library';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import {
  descNullsLast,
  findAlbumsWithPlayableTracks,
  findArtistsWithPlayableTracks,
  findPlaylistsWithPlayableTracks,
  imageFirst,
} from '../db/catalog/containers';
import { toAlbumDtos, toArtistDtos, toPlaylistDtos, toTrackDtos } from '../db/catalog/hydrate';
import { normalizeImageRef, type PublicTrackRow } from '../db/catalog/serialize';
import { playableTrackFilter } from '../db/catalog/visibility';
import { parseBoundedLimit, parseOffset } from '../utils/reqParams';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequestUserId } from '../utils/requestUser';
import { getMadeForYou as getPersonalisedMadeForYou } from '../services/recommendations/recommendationService';

/**
 * Default genre colors for genre cards (Spotify-like colors)
 */
const GENRE_COLORS: Record<string, string> = {
  'Rock': '#E13300',
  'Pop': '#8D67AB',
  'Hip-Hop': '#BA5D07',
  'Jazz': '#148A08',
  'Classical': '#E8115B',
  'Electronic': '#E1118C',
  'Country': '#D84000',
  'R&B': '#EB1E32',
  'Reggae': '#D84000',
  'Latin': '#BA5D07',
  'Indie': '#E1118C',
  'Alternative': '#E8115B',
  'Dance': '#1E3264',
  'Blues': '#148A08',
  'Folk': '#1E3264',
};

/** How many genre cards the browse screen renders. */
const GENRE_CARD_LIMIT = 20;

/** The public columns of `tracks` — no `sha256`, no `images`. */
const publicTrackColumns = () => publicColumns(tracks, PROTECTED_COLUMNS_BY_TABLE);

/**
 * "Most popular first" for tracks, artists, albums and playlists.
 *
 * Each is the Mongo sort with its `withImageFirstSort` prefix translated to
 * `imageFirst()` — a sort on the PREDICATE `(column is not null)`, not on the
 * image id's lexical value, which is what the Mongo `{ coverArt: -1 }` prefix
 * actually did. `albums.cover_art_id` is `NOT NULL`, so the album orderings
 * carry no `imageFirst` term at all: it would be a constant.
 */
const TRACK_POPULAR_ORDER = [
  imageFirst(tracks.coverArtId),
  descNullsLast(tracks.popularity),
  descNullsLast(tracks.playCount),
  descNullsLast(tracks.createdAt),
];
const TRACK_CHART_ORDER = [
  imageFirst(tracks.coverArtId),
  descNullsLast(tracks.popularity),
  descNullsLast(tracks.playCount),
];
const ARTIST_POPULAR_ORDER = [
  imageFirst(catalogEntities.imageId),
  descNullsLast(catalogEntities.popularity),
  descNullsLast(catalogEntities.statsFollowers),
];
const ALBUM_POPULAR_ORDER = [descNullsLast(albums.popularity), descNullsLast(albums.releaseDate)];
const ALBUM_MADE_FOR_YOU_ORDER = [descNullsLast(albums.popularity), descNullsLast(albums.playCount)];
const PLAYLIST_MADE_FOR_YOU_ORDER = [
  imageFirst(playlists.coverArtId),
  descNullsLast(playlists.followers),
  descNullsLast(playlists.createdAt),
];

/** Playable tracks, most popular first. */
async function findPopularTracks(limit: number, offset = 0): Promise<PublicTrackRow[]> {
  const query = getDb()
    .select(publicTrackColumns())
    .from(tracks)
    .where(playableTrackFilter())
    .orderBy(...TRACK_POPULAR_ORDER)
    .limit(limit);

  return offset > 0 ? query.offset(offset) : query;
}

function setDiscoveryCache(res: Response): void {
  const value = 'public, max-age=30, stale-while-revalidate=120';
  if (typeof res.set === 'function') {
    res.set('Cache-Control', value);
    return;
  }
  if (typeof res.setHeader === 'function') {
    res.setHeader('Cache-Control', value);
  }
}

function setCatalogCache(res: Response, userId?: string): void {
  if (userId) {
    res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=120');
    res.set('Vary', 'Authorization');
    return;
  }

  setDiscoveryCache(res);
}

/** Public playlists only — the visibility every discovery shelf filters on. */
const publicPlaylist = () => eq(playlists.visibility, PlaylistVisibility.PUBLIC);

/**
 * GET /api/browse/home
 * Aggregated public home payload. This collapses the home screen's independent
 * public discovery requests into one API round-trip while preserving the same
 * section contracts on the client.
 */
export const getHomeBrowse = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getRequestUserId(req as AuthRequest);
    const tracksLimit = parseBoundedLimit(req.query.tracksLimit, 20, 50);
    const sectionLimit = parseBoundedLimit(req.query.sectionLimit, 8, 20);
    const madeForYouHalf = Math.max(1, Math.floor(sectionLimit / 2));

    const [
      madeForYouAlbums,
      madeForYouPlaylists,
      popularAlbums,
      popularArtists,
      trackRows,
    ] = await Promise.all([
      findAlbumsWithPlayableTracks(undefined, {
        orderBy: ALBUM_MADE_FOR_YOU_ORDER,
        limit: madeForYouHalf,
      }),
      findPlaylistsWithPlayableTracks(publicPlaylist(), {
        orderBy: PLAYLIST_MADE_FOR_YOU_ORDER,
        limit: madeForYouHalf,
      }),
      findAlbumsWithPlayableTracks(undefined, {
        orderBy: ALBUM_POPULAR_ORDER,
        limit: sectionLimit,
      }),
      findArtistsWithPlayableTracks(undefined, {
        orderBy: ARTIST_POPULAR_ORDER,
        limit: sectionLimit,
      }),
      findPopularTracks(tracksLimit),
    ]);

    // Personalised "Made For You": when the request is authenticated, surface a
    // taste-driven blend of fresh tracks + artists from the recommendation
    // engine. Falls back to popular albums/playlists for guests (and is honest
    // about it via the `personalized` flag).
    let madeForYou: {
      albums: unknown[];
      playlists: unknown[];
      tracks: unknown[];
      artists: unknown[];
      personalized: boolean;
    };

    if (userId) {
      const personalised = await getPersonalisedMadeForYou(userId, sectionLimit);
      madeForYou = {
        albums: await toAlbumDtos(madeForYouAlbums),
        playlists: await toPlaylistDtos(madeForYouPlaylists),
        tracks: await toTrackDtos(personalised.tracks),
        artists: await toArtistDtos(personalised.artists),
        personalized: personalised.personalized,
      };
    } else {
      const sparse = madeForYouAlbums.length + madeForYouPlaylists.length < madeForYouHalf;
      const [fallbackTracks, fallbackArtists] = sparse
        ? await Promise.all([
            findPopularTracks(sectionLimit),
            findArtistsWithPlayableTracks(undefined, {
              orderBy: ARTIST_POPULAR_ORDER,
              limit: sectionLimit,
            }),
          ])
        : [[], []];
      madeForYou = {
        albums: await toAlbumDtos(madeForYouAlbums),
        playlists: await toPlaylistDtos(madeForYouPlaylists),
        tracks: await toTrackDtos(fallbackTracks),
        artists: await toArtistDtos(fallbackArtists),
        personalized: false,
      };
    }

    const formattedTracks = await toTrackDtos(trackRows);
    if (userId) {
      // The madeForYou section is personalised; never store it in a shared cache.
      res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
      res.set('Vary', 'Authorization');
    } else {
      setDiscoveryCache(res);
    }
    res.json({
      madeForYou,
      popularAlbums: {
        albums: await toAlbumDtos(popularAlbums),
        total: popularAlbums.length,
        hasMore: popularAlbums.length === sectionLimit,
      },
      popularArtists: {
        artists: await toArtistDtos(popularArtists),
        total: popularArtists.length,
        hasMore: popularArtists.length === sectionLimit,
      },
      tracks: {
        tracks: formattedTracks,
        total: formattedTracks.length,
        hasMore: formattedTracks.length === tracksLimit,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/browse/genres
 * Get list of available genres with sample content
 */
export const getGenres = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getRequestUserId(req as AuthRequest);

    /**
     * The genres backed by at least one PLAYABLE track, and the cover art of
     * each one's most popular track — in ONE query rather than a `distinct`
     * followed by a `find` per genre.
     *
     * Mongo needed 1 + N round trips (`distinct('genre', …)`, then a sorted
     * `find().limit(1)` for every genre) because it has no lateral join.
     * `distinct on (genre)` with a matching `order by` is exactly "the first row
     * per genre", so the sample track falls out of the same scan that
     * enumerates the genres.
     *
     * `tracks_genre_idx` is partial on the playability predicate, which
     * `playableTrackFilter()` supplies — without it Postgres cannot use the
     * index at all.
     */
    const rows = await getDb()
      .selectDistinctOn([tracks.genre], { genre: tracks.genre, coverArtId: tracks.coverArtId })
      .from(tracks)
      // `<> ''` alongside `is not null`, because the Mongo version's
      // `.filter(Boolean)` dropped both shapes and only one of them is a null.
      .where(and(playableTrackFilter(), isNotNull(tracks.genre), ne(tracks.genre, '')))
      // `genre` LEADS the ordering because `distinct on` requires it to; the
      // rest is the sample track's own ordering — has-a-cover first, then
      // popularity, then plays, exactly what `withImageFirstSort` expressed.
      .orderBy(
        tracks.genre,
        imageFirst(tracks.coverArtId),
        descNullsLast(tracks.popularity),
        descNullsLast(tracks.playCount)
      )
      .limit(GENRE_CARD_LIMIT);

    const genres = rows.map((row) => ({
      // `isNotNull` above narrows the ROWS, not the column's TypeScript type.
      name: row.genre ?? '',
      color: GENRE_COLORS[row.genre ?? ''] || '#1E3264',
      /**
       * `?? null`, because the contract is `string | null` and
       * `normalizeImageRef` answers `undefined` — which `res.json` would DROP
       * from the payload rather than send as null. `toInternalImageUrl` lived
       * here and did the same job with a 24-hex test that no longer matches an
       * `image_assets` uuid; it is deleted in favour of the one normalizer every
       * catalog serializer already uses.
       */
      coverArt: normalizeImageRef(row.coverArtId) ?? null,
    }));

    setCatalogCache(res, userId);
    res.json({ genres });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/browse/genres/:genre/tracks
 * Get playable tracks for a genre in popularity order.
 */
export const getGenreTracks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const genre = decodeURIComponent(String(req.params.genre ?? '')).trim();
    if (!genre) {
      return res.status(400).json({ error: 'Genre is required' });
    }

    const userId = getRequestUserId(req as AuthRequest);
    const limit = parseBoundedLimit(req.query.limit, 50);
    const offset = parseOffset(req.query.offset);

    const rows = await getDb()
      .select(publicTrackColumns())
      .from(tracks)
      .where(and(playableTrackFilter(), eq(tracks.genre, genre)))
      .orderBy(...TRACK_POPULAR_ORDER)
      .offset(offset)
      .limit(limit);

    const formattedTracks = await toTrackDtos(rows);

    setCatalogCache(res, userId);
    res.json({
      tracks: formattedTracks,
      total: formattedTracks.length,
      hasMore: formattedTracks.length === limit,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/browse/popular/tracks
 * Get popular/trending tracks
 */
export const getPopularTracks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getRequestUserId(req as AuthRequest);
    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);

    const formattedTracks = await toTrackDtos(await findPopularTracks(limit, offset));

    setCatalogCache(res, userId);
    res.json({
      tracks: formattedTracks,
      total: formattedTracks.length,
      hasMore: formattedTracks.length === limit,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/browse/popular/albums
 * Get popular/trending albums
 */
export const getPopularAlbums = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const userId = getRequestUserId(req as AuthRequest);

    const formattedAlbums = await toAlbumDtos(
      await findAlbumsWithPlayableTracks(undefined, {
        orderBy: ALBUM_POPULAR_ORDER,
        offset,
        limit,
      })
    );

    setCatalogCache(res, userId);
    res.json({
      albums: formattedAlbums,
      total: formattedAlbums.length,
      hasMore: formattedAlbums.length === limit,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/browse/popular/artists
 * Get popular/trending artists
 */
export const getPopularArtists = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const userId = getRequestUserId(req as AuthRequest);

    const formattedArtists = await toArtistDtos(
      await findArtistsWithPlayableTracks(undefined, {
        orderBy: ARTIST_POPULAR_ORDER,
        offset,
        limit,
      })
    );

    setCatalogCache(res, userId);
    res.json({
      artists: formattedArtists,
      total: formattedArtists.length,
      hasMore: formattedArtists.length === limit,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/browse/made-for-you
 * Personalised recommendations. For a signed-in user, returns a taste-driven
 * blend of fresh tracks + artists from the recommendation engine plus popular
 * albums/playlists to browse. Guests receive popular content (flagged via
 * `personalized: false`).
 */
export const getMadeForYou = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getRequestUserId(req as AuthRequest);
    const limit = parseBoundedLimit(req.query.limit, 20);
    const half = Math.max(1, Math.floor(limit / 2));

    const [albumRows, playlistRows] = await Promise.all([
      findAlbumsWithPlayableTracks(undefined, {
        orderBy: ALBUM_MADE_FOR_YOU_ORDER,
        limit: half,
      }),
      findPlaylistsWithPlayableTracks(publicPlaylist(), {
        orderBy: PLAYLIST_MADE_FOR_YOU_ORDER,
        limit: half,
      }),
    ]);

    if (userId) {
      const personalised = await getPersonalisedMadeForYou(userId, limit);
      res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
      res.set('Vary', 'Authorization');
      res.json({
        albums: await toAlbumDtos(albumRows),
        playlists: await toPlaylistDtos(playlistRows),
        tracks: await toTrackDtos(personalised.tracks),
        artists: await toArtistDtos(personalised.artists),
        personalized: personalised.personalized,
      });
      return;
    }

    // Guest fallback: when albums + playlists are sparse (early catalog), surface
    // popular tracks and artists so the section is never empty.
    const sparse = albumRows.length + playlistRows.length < half;
    const [trackRows, artistRows] = sparse
      ? await Promise.all([
          findPopularTracks(limit),
          findArtistsWithPlayableTracks(undefined, {
            orderBy: ARTIST_POPULAR_ORDER,
            limit,
          }),
        ])
      : [[], []];

    setCatalogCache(res, userId);
    res.json({
      albums: await toAlbumDtos(albumRows),
      playlists: await toPlaylistDtos(playlistRows),
      tracks: await toTrackDtos(trackRows),
      artists: await toArtistDtos(artistRows),
      personalized: false,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/browse/charts
 * Get top charts/top songs
 */
export const getCharts = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getRequestUserId(req as AuthRequest);
    const limit = parseBoundedLimit(req.query.limit, 50);

    const rows = await getDb()
      .select(publicTrackColumns())
      .from(tracks)
      .where(playableTrackFilter())
      .orderBy(...TRACK_CHART_ORDER)
      .limit(limit);

    const formattedTracks = await toTrackDtos(rows);

    setCatalogCache(res, userId);
    res.json({
      tracks: formattedTracks,
      total: formattedTracks.length,
    });
  } catch (error) {
    next(error);
  }
};
