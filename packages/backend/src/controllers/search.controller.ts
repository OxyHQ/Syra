import { Request, Response, NextFunction } from 'express';
import { SearchCategory, SearchResult, SearchUser } from '@syra/shared-types';
import { getAccountDisplayName } from '@oxyhq/core';
import type { User } from '@oxyhq/core';
import { TrackModel } from '../models/Track';
import { AlbumModel } from '../models/Album';
import { ArtistModel } from '../models/Artist';
import { PlaylistModel } from '../models/Playlist';
import { toApiFormatArray, formatTracksWithCoverArt, formatAlbumsWithCoverArt, formatArtistsWithImage, formatPlaylistsWithCoverArt } from '../utils/musicHelpers';
import { isDatabaseConnected } from '../utils/database';
import { enqueueAudiusImport } from '../services/sources/audiusBackgroundImport';
import { withImageFirstSort } from '../utils/imageFirstSort';
import { logger } from '../utils/logger';
import { oxy } from '../../server';

/**
 * Local track count below this threshold triggers a background Audius import
 * for the same query and signals `pendingAudiusImport: true` to the client.
 */
const AUDIUS_IMPORT_SPARSE_THRESHOLD = 5;

function formatOxyUser(profile: User): SearchUser {
  return {
    id: profile.id,
    username: profile.username,
    displayName: getAccountDisplayName(profile),
    avatar: profile.avatar || undefined,
    bio: profile.bio || undefined,
    followers: profile._count?.followers,
    following: profile._count?.following,
  };
}

async function searchOxyUsers(query: string, limit: number, offset: number): Promise<[SearchUser[], number]> {
  try {
    const response = await oxy.searchProfiles(query, { limit, offset });
    const users = (response.data || []).map(formatOxyUser);

    return [users, response.pagination?.total ?? users.length];
  } catch (error) {
    logger.warn('Failed searching Oxy profiles', { query, error });
    return [[], 0];
  }
}

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
          users: [],
        },
        counts: {
          tracks: 0,
          albums: 0,
          artists: 0,
          playlists: 0,
          users: 0,
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
      users?: Promise<[SearchUser[], number]>;
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
          .sort(withImageFirstSort('track', { popularity: -1, createdAt: -1 }))
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
          .sort(withImageFirstSort('album', { popularity: -1, releaseDate: -1 }))
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
          .sort(withImageFirstSort('artist', { popularity: -1, 'stats.followers': -1 }))
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
          .sort(withImageFirstSort('playlist', { followers: -1, createdAt: -1 }))
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

    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.USERS) {
      searchPromises.users = searchOxyUsers(query, searchLimit, searchOffset);
    }

    // Execute all search queries in parallel
    const [
      tracksResult,
      albumsResult,
      artistsResult,
      playlistsResult,
      usersResult,
    ] = await Promise.all([
      searchPromises.tracks ?? Promise.resolve<[unknown[], number]>([[], 0]),
      searchPromises.albums ?? Promise.resolve<[unknown[], number]>([[], 0]),
      searchPromises.artists ?? Promise.resolve<[unknown[], number]>([[], 0]),
      searchPromises.playlists ?? Promise.resolve<[unknown[], number]>([[], 0]),
      searchPromises.users ?? Promise.resolve<[SearchUser[], number]>([[], 0]),
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
    const formattedUsers = categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.USERS
      ? usersResult[0]
      : [];

    // Calculate counts and totals
    const tracksCount = tracksResult[1];
    const albumsCount = albumsResult[1];
    const artistsCount = artistsResult[1];
    const playlistsCount = playlistsResult[1];
    const usersCount = usersResult[1];
    const totalCount = tracksCount + albumsCount + artistsCount + playlistsCount + usersCount;

    // Determine if there are more results
    const hasMore = categoryValue === SearchCategory.ALL
      ? totalCount > searchOffset + searchLimit
      : (categoryValue === SearchCategory.TRACKS && tracksCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.ALBUMS && albumsCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.ARTISTS && artistsCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.PLAYLISTS && playlistsCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.USERS && usersCount > searchOffset + searchLimit);

    const results: SearchResult = {
      query,
      results: {
        tracks: formattedTracks,
        albums: formattedAlbums,
        artists: formattedArtists,
        playlists: formattedPlaylists,
        users: formattedUsers,
      },
      counts: {
        tracks: tracksCount,
        albums: albumsCount,
        artists: artistsCount,
        playlists: playlistsCount,
        users: usersCount,
        total: totalCount,
      },
      hasMore,
      offset: searchOffset,
      limit: searchLimit,
    };

    // Fire-and-forget background Audius import for track/all searches.
    // Kicks off asynchronously — never delays the response.
    const isTrackSearch =
      categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.TRACKS;
    const sparseLocalResults = tracksCount < AUDIUS_IMPORT_SPARSE_THRESHOLD;
    const pendingAudiusImport = isTrackSearch && sparseLocalResults;

    if (isTrackSearch) {
      enqueueAudiusImport(query);
    }

    res.json({ ...results, pendingAudiusImport });
  } catch (error) {
    next(error);
  }
};
