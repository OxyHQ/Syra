import { Request, Response, NextFunction } from 'express';
import { SearchCategory, SearchResult } from '@syra/shared-types';
import { TrackModel } from '../models/Track';
import { AlbumModel } from '../models/Album';
import { ArtistModel } from '../models/Artist';
import { PlaylistModel } from '../models/Playlist';
import { toApiFormatArray, formatTracksWithCoverArt, formatAlbumsWithCoverArt, formatArtistsWithImage, formatPlaylistsWithCoverArt } from '../utils/musicHelpers';
import { isDatabaseConnected } from '../utils/database';

/**
 * GET /api/search
 * Unified search across tracks, albums, artists, and playlists
 */
export const search = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { q, category = 'all', limit = 20, offset = 0 } = req.query;
    const query = (q as string) || '';
    const searchCategory = category as SearchCategory;
    const searchLimit = parseInt(limit as string) || 20;
    const searchOffset = parseInt(offset as string) || 0;

    // If no query, return empty results
    if (!query.trim()) {
      const emptyResults: SearchResult = {
        query: '',
        results: {
          tracks: [],
          albums: [],
          artists: [],
          playlists: [],
        },
        counts: {
          tracks: 0,
          albums: 0,
          artists: 0,
          playlists: 0,
          total: 0,
        },
        hasMore: false,
        offset: searchOffset,
        limit: searchLimit,
      };
      return res.json(emptyResults);
    }

    // Create regex for case-insensitive search
    const searchRegex = new RegExp(query, 'i');

    // Build search promises based on category
    const searchPromises: {
      tracks?: Promise<[any[], number]>;
      albums?: Promise<[any[], number]>;
      artists?: Promise<[any[], number]>;
      playlists?: Promise<[any[], number]>;
    } = {};

    // Normalize category to enum value
    const categoryValue = searchCategory.toLowerCase() as SearchCategory;

    // Search tracks
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.TRACKS) {
      searchPromises.tracks = Promise.all([
        TrackModel.find({
          isAvailable: true,
          $or: [
            { title: searchRegex },
            { artistName: searchRegex },
          ],
        })
          .sort({ popularity: -1, createdAt: -1 })
          .skip(searchOffset)
          .limit(searchLimit)
          .lean(),
        TrackModel.countDocuments({
          isAvailable: true,
          $or: [
            { title: searchRegex },
            { artistName: searchRegex },
          ],
        }),
      ]);
    }

    // Search albums
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.ALBUMS) {
      searchPromises.albums = Promise.all([
        AlbumModel.find({
          $or: [
            { title: searchRegex },
            { artistName: searchRegex },
          ],
        })
          .sort({ popularity: -1, releaseDate: -1 })
          .skip(searchOffset)
          .limit(searchLimit)
          .lean(),
        AlbumModel.countDocuments({
          $or: [
            { title: searchRegex },
            { artistName: searchRegex },
          ],
        }),
      ]);
    }

    // Search artists
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.ARTISTS) {
      searchPromises.artists = Promise.all([
        ArtistModel.find({
          name: searchRegex,
        })
          .sort({ popularity: -1, 'stats.followers': -1 })
          .skip(searchOffset)
          .limit(searchLimit)
          .lean(),
        ArtistModel.countDocuments({
          name: searchRegex,
        }),
      ]);
    }

    // Search playlists (only public playlists for now)
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.PLAYLISTS) {
      searchPromises.playlists = Promise.all([
        PlaylistModel.find({
          isPublic: true,
          $or: [
            { name: searchRegex },
            { description: searchRegex },
          ],
        })
          .sort({ followers: -1, createdAt: -1 })
          .skip(searchOffset)
          .limit(searchLimit)
          .lean(),
        PlaylistModel.countDocuments({
          isPublic: true,
          $or: [
            { name: searchRegex },
            { description: searchRegex },
          ],
        }),
      ]);
    }

    // Execute all search queries in parallel
    const [
      tracksResult,
      albumsResult,
      artistsResult,
      playlistsResult,
    ] = await Promise.all([
      searchPromises.tracks || Promise.resolve([[], 0]),
      searchPromises.albums || Promise.resolve([[], 0]),
      searchPromises.artists || Promise.resolve([[], 0]),
      searchPromises.playlists || Promise.resolve([[], 0]),
    ]);

    // Format results
    const formattedTracks = categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.TRACKS
      ? await formatTracksWithCoverArt(tracksResult[0])
      : [];
    const formattedAlbums = categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.ALBUMS
      ? formatAlbumsWithCoverArt(albumsResult[0])
      : [];
    const formattedArtists = categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.ARTISTS
      ? formatArtistsWithImage(artistsResult[0])
      : [];
    const formattedPlaylists = categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.PLAYLISTS
      ? formatPlaylistsWithCoverArt(playlistsResult[0])
      : [];

    // Calculate counts and totals
    const tracksCount = tracksResult[1];
    const albumsCount = albumsResult[1];
    const artistsCount = artistsResult[1];
    const playlistsCount = playlistsResult[1];
    const totalCount = tracksCount + albumsCount + artistsCount + playlistsCount;

    // Determine if there are more results
    const hasMore = categoryValue === SearchCategory.ALL
      ? totalCount > searchOffset + searchLimit
      : (categoryValue === SearchCategory.TRACKS && tracksCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.ALBUMS && albumsCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.ARTISTS && artistsCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.PLAYLISTS && playlistsCount > searchOffset + searchLimit);

    const results: SearchResult = {
      query,
      results: {
        tracks: formattedTracks,
        albums: formattedAlbums,
        artists: formattedArtists,
        playlists: formattedPlaylists,
      },
      counts: {
        tracks: tracksCount,
        albums: albumsCount,
        artists: artistsCount,
        playlists: playlistsCount,
        total: totalCount,
      },
      hasMore,
      offset: searchOffset,
      limit: searchLimit,
    };

    res.json(results);
  } catch (error) {
    next(error);
  }
};

