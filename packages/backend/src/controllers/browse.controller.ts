import { Request, Response, NextFunction } from 'express';
import { PlaylistVisibility } from '@syra/shared-types';
import { TrackModel } from '../models/Track';
import { formatTracksWithCoverArt, formatArtistsWithImage, formatPlaylistsWithCoverArt, formatAlbumsWithCoverArt } from '../utils/musicHelpers';
import { isDatabaseConnected } from '../utils/database';
import { withImageFirstSort } from '../utils/imageFirstSort';
import { parseBoundedLimit, parseOffset } from '../utils/reqParams';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getMadeForYou as getPersonalisedMadeForYou } from '../services/recommendations/recommendationService';
import {
  getRequestUserId,
  playableTrackFilter,
} from '../utils/catalogVisibility';
import {
  findAlbumsWithPlayableTracks,
  findArtistsWithPlayableTracks,
  findPlaylistsWithPlayableTracks,
} from '../utils/playableContainers';

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

function toInternalImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith('/api/images/')) return value;
  if (/^[a-f\d]{24}$/i.test(value)) return `/api/images/${value}`;
  return null;
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

/**
 * GET /api/browse/home
 * Aggregated public home payload. This collapses the home screen's independent
 * public discovery requests into one API round-trip while preserving the same
 * section contracts on the client.
 */
export const getHomeBrowse = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
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
      tracks,
    ] = await Promise.all([
      findAlbumsWithPlayableTracks({}, {
        sort: withImageFirstSort('album', { popularity: -1, playCount: -1 }),
        limit: madeForYouHalf,
      }),
      findPlaylistsWithPlayableTracks({ visibility: PlaylistVisibility.PUBLIC }, {
        sort: withImageFirstSort('playlist', { followers: -1, createdAt: -1 }),
        limit: madeForYouHalf,
      }),
      findAlbumsWithPlayableTracks({}, {
        sort: withImageFirstSort('album', { popularity: -1, releaseDate: -1 }),
        limit: sectionLimit,
      }),
      findArtistsWithPlayableTracks({}, {
        sort: withImageFirstSort('artist', { popularity: -1, 'stats.followers': -1 }),
        limit: sectionLimit,
      }),
      TrackModel.find(playableTrackFilter({}))
        .sort(withImageFirstSort('track', { popularity: -1, playCount: -1, createdAt: -1 }))
        .limit(tracksLimit)
        .lean(),
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
        albums: formatAlbumsWithCoverArt(madeForYouAlbums),
        playlists: formatPlaylistsWithCoverArt(madeForYouPlaylists),
        tracks: await formatTracksWithCoverArt(personalised.tracks),
        artists: formatArtistsWithImage(personalised.artists),
        personalized: personalised.personalized,
      };
    } else {
      const sparse = madeForYouAlbums.length + madeForYouPlaylists.length < madeForYouHalf;
      const [fallbackTracks, fallbackArtists] = sparse
        ? await Promise.all([
            TrackModel.find(playableTrackFilter({}))
              .sort(withImageFirstSort('track', { popularity: -1, playCount: -1, createdAt: -1 }))
              .limit(sectionLimit)
              .lean(),
            findArtistsWithPlayableTracks({}, {
              sort: withImageFirstSort('artist', { popularity: -1, 'stats.followers': -1 }),
              limit: sectionLimit,
            }),
          ])
        : [[], []];
      madeForYou = {
        albums: formatAlbumsWithCoverArt(madeForYouAlbums),
        playlists: formatPlaylistsWithCoverArt(madeForYouPlaylists),
        tracks: await formatTracksWithCoverArt(fallbackTracks),
        artists: formatArtistsWithImage(fallbackArtists),
        personalized: false,
      };
    }

    const formattedTracks = await formatTracksWithCoverArt(tracks);
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
        albums: formatAlbumsWithCoverArt(popularAlbums),
        total: popularAlbums.length,
        hasMore: popularAlbums.length === sectionLimit,
      },
      popularArtists: {
        artists: formatArtistsWithImage(popularArtists),
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
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getRequestUserId(req as AuthRequest);

    // Aggregate unique genres from playable tracks, so genres only surface when
    // the current user can actually play music in that genre.
    const trackGenres = await TrackModel.distinct('genre', playableTrackFilter({}));

    const allGenres = [...new Set(trackGenres.flat().filter(Boolean))];

    // Get a playable sample track for each genre to supply cover art.
    const genresWithSamples = await Promise.all(
      allGenres.slice(0, 20).map(async (genre) => {
        const sampleTracks = await TrackModel.find(playableTrackFilter({ genre: genre }))
          .sort(withImageFirstSort('track', { popularity: -1, playCount: -1 }))
          .limit(1)
          .lean();
        const sampleTrack = sampleTracks[0];

        return {
          name: genre,
          color: GENRE_COLORS[genre] || '#1E3264',
          coverArt: toInternalImageUrl(sampleTrack?.coverArt) || null,
        };
      })
    );

    setCatalogCache(res, userId);
    res.json({ genres: genresWithSamples });
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
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const genre = decodeURIComponent(String(req.params.genre ?? '')).trim();
    if (!genre) {
      return res.status(400).json({ error: 'Genre is required' });
    }

    const userId = getRequestUserId(req as AuthRequest);
    const limit = parseBoundedLimit(req.query.limit, 50);
    const offset = parseOffset(req.query.offset);

    const tracks = await TrackModel.find(playableTrackFilter({ genre }))
      .sort(withImageFirstSort('track', { popularity: -1, playCount: -1, createdAt: -1 }))
      .skip(offset)
      .limit(limit)
      .lean();

    const formattedTracks = await formatTracksWithCoverArt(tracks);

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
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getRequestUserId(req as AuthRequest);
    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);

    const tracks = await TrackModel.find(playableTrackFilter({}))
      .sort(withImageFirstSort('track', { popularity: -1, playCount: -1, createdAt: -1 }))
      .skip(offset)
      .limit(limit)
      .lean();

    const formattedTracks = await formatTracksWithCoverArt(tracks);

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
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const userId = getRequestUserId(req as AuthRequest);

    const albums = await findAlbumsWithPlayableTracks({}, {
      sort: withImageFirstSort('album', { popularity: -1, releaseDate: -1 }),
      offset,
      limit,
    });

    const formattedAlbums = formatAlbumsWithCoverArt(albums);

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
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const limit = parseBoundedLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const userId = getRequestUserId(req as AuthRequest);

    const artists = await findArtistsWithPlayableTracks({}, {
      sort: withImageFirstSort('artist', { popularity: -1, 'stats.followers': -1 }),
      offset,
      limit,
    });

    const formattedArtists = formatArtistsWithImage(artists);

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
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getRequestUserId(req as AuthRequest);
    const limit = parseBoundedLimit(req.query.limit, 20);
    const half = Math.max(1, Math.floor(limit / 2));

    const [albums, playlists] = await Promise.all([
      findAlbumsWithPlayableTracks({}, {
        sort: withImageFirstSort('album', { popularity: -1, playCount: -1 }),
        limit: half,
      }),
      findPlaylistsWithPlayableTracks({ visibility: PlaylistVisibility.PUBLIC }, {
        sort: withImageFirstSort('playlist', { followers: -1, createdAt: -1 }),
        limit: half,
      }),
    ]);

    if (userId) {
      const personalised = await getPersonalisedMadeForYou(userId, limit);
      res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
      res.set('Vary', 'Authorization');
      res.json({
        albums: formatAlbumsWithCoverArt(albums),
        playlists: formatPlaylistsWithCoverArt(playlists),
        tracks: await formatTracksWithCoverArt(personalised.tracks),
        artists: formatArtistsWithImage(personalised.artists),
        personalized: personalised.personalized,
      });
      return;
    }

    // Guest fallback: when albums + playlists are sparse (early catalog), surface
    // popular tracks and artists so the section is never empty.
    const sparse = albums.length + playlists.length < half;
    const [tracks, artists] = sparse
      ? await Promise.all([
          TrackModel.find(playableTrackFilter({}))
            .sort(withImageFirstSort('track', { popularity: -1, playCount: -1, createdAt: -1 }))
            .limit(limit)
            .lean(),
          findArtistsWithPlayableTracks({}, {
            sort: withImageFirstSort('artist', { popularity: -1, 'stats.followers': -1 }),
            limit,
          }),
        ])
      : [[], []];

    setCatalogCache(res, userId);
    res.json({
      albums: formatAlbumsWithCoverArt(albums),
      playlists: formatPlaylistsWithCoverArt(playlists),
      tracks: await formatTracksWithCoverArt(tracks),
      artists: formatArtistsWithImage(artists),
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
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const userId = getRequestUserId(req as AuthRequest);
    const limit = parseBoundedLimit(req.query.limit, 50);

    const tracks = await TrackModel.find(playableTrackFilter({}))
      .sort(withImageFirstSort('track', { popularity: -1, playCount: -1 }))
      .limit(limit)
      .lean();

    const formattedTracks = await formatTracksWithCoverArt(tracks);

    setCatalogCache(res, userId);
    res.json({
      tracks: formattedTracks,
      total: formattedTracks.length,
    });
  } catch (error) {
    next(error);
  }
};
