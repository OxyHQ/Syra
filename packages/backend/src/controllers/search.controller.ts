import { Request, Response, NextFunction } from 'express';
import { PlaylistVisibility, SearchCategory, SearchResult, SearchUser } from '@syra/shared-types';
import { getAccountDisplayName } from '@oxyhq/core';
import type { User } from '@oxyhq/core';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { env } from '../config/env';
import { TrackModel } from '../models/Track';
import { PodcastModel } from '../models/Podcast';
import { hiddenShowEpisodeFilter } from '../utils/podcastDiscovery';
import { EpisodeModel } from '../models/Episode';
import { PersonModel } from '../models/CatalogEntity';
import { formatTracksWithCoverArt, formatAlbumsWithCoverArt, formatArtistsWithImage, formatPlaylistsWithCoverArt } from '../utils/musicHelpers';
import { serializePodcast, serializeEpisode, type PodcastDocument, type EpisodeDocument } from '../services/podcasts/podcastSerializers';
import { loadShowArtworkByPodcastId } from '../services/podcasts/episodeShowArtwork';
import { enrichPersons, makeOxyUsersFetcher, type PersonLike } from '../services/podcasts/resolvePersons';
import { isDatabaseConnected } from '../utils/database';
import { enqueueAudiusImport } from '../services/sources/audiusBackgroundImport';
import { syncPodcastSearch } from '../services/podcasts/podcastBackgroundImport';
import { withImageFirstSort } from '../utils/imageFirstSort';
import { logger } from '../utils/logger';
import {
  getRequestUserId,
  playableTrackFilter,
  resolveCatalogPlaybackOptions,
} from '../utils/catalogVisibility';
import {
  countAlbumsWithPlayableTracks,
  countArtistsWithPlayableTracks,
  countPlaylistsWithPlayableTracks,
  findAlbumsWithPlayableTracks,
  findArtistsWithPlayableTracks,
  findPlaylistsWithPlayableTracks,
} from '../utils/playableContainers';
import { oxy } from '../oxyClient';

/**
 * Local track count below this threshold triggers a background Audius import
 * for the same query and signals `pendingAudiusImport: true` to the client.
 */
const AUDIUS_IMPORT_SPARSE_THRESHOLD = 5;
const AUDIUS_IMPORT_MIN_QUERY_LENGTH = 3;
const HEADER_PREVIEW_LIMIT = 5;
const SEARCH_LIMIT_MAX = 50;

function parseSearchLimit(value: unknown): number {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }
  return Math.min(parsed, SEARCH_LIMIT_MAX);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
    const searchLimit = parseSearchLimit(limit);
    const searchOffset = parseInt(offset as string) || 0;
    const playbackOptions = await resolveCatalogPlaybackOptions(getRequestUserId(req as AuthRequest));

    // If no query, return empty results
    if (!query.trim()) {
      const emptyResults: SearchResult = {
        query: '',
        results: {
          tracks: [],
          albums: [],
          artists: [],
          playlists: [],
          podcasts: [],
          episodes: [],
          people: [],
          users: [],
        },
        counts: {
          tracks: 0,
          albums: 0,
          artists: 0,
          playlists: 0,
          podcasts: 0,
          episodes: 0,
          people: 0,
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
    const searchRegex = new RegExp(escapeRegex(query.trim()), 'i');

    // Build search promises based on category
    const searchPromises: {
      tracks?: Promise<[unknown[], number]>;
      albums?: Promise<[unknown[], number]>;
      artists?: Promise<[unknown[], number]>;
      playlists?: Promise<[unknown[], number]>;
      podcasts?: Promise<[unknown[], number]>;
      episodes?: Promise<[unknown[], number]>;
      people?: Promise<[unknown[], number]>;
      users?: Promise<[SearchUser[], number]>;
    } = {};

    // Normalize category to enum value
    const categoryValue = searchCategory.toLowerCase() as SearchCategory;

    const isPreviewSearch =
      searchOffset === 0 &&
      searchLimit <= HEADER_PREVIEW_LIMIT &&
      categoryValue === SearchCategory.ALL;

    // Search tracks
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.TRACKS) {
      const trackFilter = playableTrackFilter({
          $or: [
            { title: searchRegex },
            { artistName: searchRegex },
          ],
        }, playbackOptions);
      const trackFind = TrackModel.find(trackFilter)
          .sort(withImageFirstSort('track', { popularity: -1, createdAt: -1 }))
          .skip(searchOffset)
          .limit(searchLimit)
          .lean();
      searchPromises.tracks = isPreviewSearch
        ? trackFind.then((docs) => [docs, docs.length])
        : Promise.all([
            trackFind,
            TrackModel.countDocuments(trackFilter),
          ]);
    }

    // Search albums
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.ALBUMS) {
      const albumFilter = {
          $or: [
            { title: searchRegex },
            { artistName: searchRegex },
          ],
        };
      const albumFind = findAlbumsWithPlayableTracks(albumFilter, playbackOptions, {
        sort: withImageFirstSort('album', { popularity: -1, releaseDate: -1 }),
        offset: searchOffset,
        limit: searchLimit,
      });
      searchPromises.albums = isPreviewSearch
        ? albumFind.then((docs) => [docs, docs.length])
        : Promise.all([
            albumFind,
            countAlbumsWithPlayableTracks(albumFilter, playbackOptions),
          ]);
    }

    // Search artists
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.ARTISTS) {
      const artistFilter = {
          name: searchRegex,
        };
      const artistFind = findArtistsWithPlayableTracks(artistFilter, playbackOptions, {
        sort: withImageFirstSort('artist', { popularity: -1, 'stats.followers': -1 }),
        offset: searchOffset,
        limit: searchLimit,
      });
      searchPromises.artists = isPreviewSearch
        ? artistFind.then((docs) => [docs, docs.length])
        : Promise.all([
            artistFind,
            countArtistsWithPlayableTracks(artistFilter, playbackOptions),
          ]);
    }

    // Search playlists (only public playlists for now)
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.PLAYLISTS) {
      const playlistFilter = {
        visibility: PlaylistVisibility.PUBLIC,
        $or: [
          { name: searchRegex },
          { description: searchRegex },
        ],
      };
      const playlistFind = findPlaylistsWithPlayableTracks(playlistFilter, playbackOptions, {
        sort: withImageFirstSort('playlist', { followers: -1, createdAt: -1 }),
        offset: searchOffset,
        limit: searchLimit,
      });
      searchPromises.playlists = isPreviewSearch
        ? playlistFind.then((docs) => [docs, docs.length])
        : Promise.all([
            playlistFind,
            countPlaylistsWithPlayableTracks(playlistFilter, playbackOptions),
          ]);
    }

    // Podcast enrichment. For an explicit podcasts search we AWAIT the shallow
    // upsert of directory candidates so they appear in THIS response (instant,
    // like the old discover); the heavy feed import runs in the background. For
    // 'all' we enrich in the background so the aggregate search stays fast.
    // `syncPodcastSearch` is bounded + throttled and never hangs/throws.
    let podcastSyncTriggered = false;
    if (
      env.PODCAST_BULK_IMPORT_ENABLED !== 'false' &&
      query.trim().length >= AUDIUS_IMPORT_MIN_QUERY_LENGTH &&
      searchOffset === 0
    ) {
      if (categoryValue === SearchCategory.PODCASTS) {
        await syncPodcastSearch(query);
        podcastSyncTriggered = true;
      } else if (categoryValue === SearchCategory.ALL && !isPreviewSearch) {
        void syncPodcastSearch(query);
        podcastSyncTriggered = true;
      }
    }

    // Search podcasts (our mirrored catalog; podcasts are free → no playback filter).
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.PODCASTS) {
      const podcastFilter = {
        status: 'active' as const,
        $or: [
          { title: searchRegex },
          { author: searchRegex },
        ],
      };
      const podcastFind = PodcastModel.find(podcastFilter)
        .sort({ popularity: -1, subscriberCount: -1, lastEpisodeAt: -1 })
        .skip(searchOffset)
        .limit(searchLimit)
        .lean();
      searchPromises.podcasts = isPreviewSearch
        ? podcastFind.then((docs) => [docs, docs.length])
        : Promise.all([
            podcastFind,
            PodcastModel.countDocuments(podcastFilter),
          ]);
    }

    // Search episodes (existing catalog, populated by the podcast feed imports —
    // no separate directory import). A public viewer sees only playable episodes:
    // `status: 'ready'` AND (a Syra-hosted episode OR an RSS episode with an
    // enclosure). Composed with `$and` so the title regex never overwrites the
    // playability `$or`.
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.EPISODES) {
      const episodeFilter = {
        status: 'ready' as const,
        title: searchRegex,
        // Episodes of an unpublished or removed show drop out of search with it.
        ...(await hiddenShowEpisodeFilter()),
        $and: [
          { $or: [{ source: 'syra' as const }, { enclosureUrl: { $exists: true, $nin: [null, ''] } }] },
        ],
      };
      const episodeFind = EpisodeModel.find(episodeFilter)
        .sort({ popularity: -1, pubDate: -1 })
        .skip(searchOffset)
        .limit(searchLimit)
        .lean();
      searchPromises.episodes = isPreviewSearch
        ? episodeFind.then((docs) => [docs, docs.length])
        : Promise.all([
            episodeFind,
            EpisodeModel.countDocuments(episodeFilter),
          ]);
    }

    // Search PEOPLE (global host/guest identities). Match the stored credit name
    // (Oxy-linked persons store the denormalised displayName) — enriched with the
    // live Oxy identity below.
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.PEOPLE) {
      const personFilter = { name: searchRegex };
      const personFind = PersonModel.find(personFilter)
        .sort({ name: 1 })
        .skip(searchOffset)
        .limit(searchLimit)
        .lean();
      searchPromises.people = isPreviewSearch
        ? personFind.then((docs) => [docs, docs.length])
        : Promise.all([
            personFind,
            PersonModel.countDocuments(personFilter),
          ]);
    }

    const includeUsers =
      categoryValue === SearchCategory.USERS ||
      (categoryValue === SearchCategory.ALL && searchLimit > HEADER_PREVIEW_LIMIT);
    if (includeUsers) {
      searchPromises.users = searchOxyUsers(query, searchLimit, searchOffset);
    }

    // Execute all search queries in parallel
    const [
      tracksResult,
      albumsResult,
      artistsResult,
      playlistsResult,
      podcastsResult,
      episodesResult,
      peopleResult,
      usersResult,
    ] = await Promise.all([
      searchPromises.tracks ?? Promise.resolve<[unknown[], number]>([[], 0]),
      searchPromises.albums ?? Promise.resolve<[unknown[], number]>([[], 0]),
      searchPromises.artists ?? Promise.resolve<[unknown[], number]>([[], 0]),
      searchPromises.playlists ?? Promise.resolve<[unknown[], number]>([[], 0]),
      searchPromises.podcasts ?? Promise.resolve<[unknown[], number]>([[], 0]),
      searchPromises.episodes ?? Promise.resolve<[unknown[], number]>([[], 0]),
      searchPromises.people ?? Promise.resolve<[unknown[], number]>([[], 0]),
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
    const formattedPodcasts = categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.PODCASTS
      ? (podcastsResult[0] as PodcastDocument[]).map(serializePodcast)
      : [];
    // Search episodes span many shows: resolve their parent-show artwork in ONE
    // `$in` query so cover-less episodes inherit it (no N+1).
    const episodeDocs = categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.EPISODES
      ? (episodesResult[0] as EpisodeDocument[])
      : [];
    const episodeShowArtwork = await loadShowArtworkByPodcastId(episodeDocs);
    const formattedEpisodes = episodeDocs.map((episode) =>
      serializeEpisode(episode, episodeShowArtwork.get(episode.podcastId.toString())),
    );
    const formattedPeople = categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.PEOPLE
      ? await enrichPersons(peopleResult[0] as PersonLike[], makeOxyUsersFetcher(oxy))
      : [];
    const formattedUsers = includeUsers
      ? usersResult[0]
      : [];

    // Calculate counts and totals
    const tracksCount = tracksResult[1];
    const albumsCount = albumsResult[1];
    const artistsCount = artistsResult[1];
    const playlistsCount = playlistsResult[1];
    const podcastsCount = podcastsResult[1];
    const episodesCount = episodesResult[1];
    const peopleCount = peopleResult[1];
    const usersCount = usersResult[1];
    const totalCount = tracksCount + albumsCount + artistsCount + playlistsCount + podcastsCount + episodesCount + peopleCount + usersCount;

    // Determine if there are more results
    const hasMore = categoryValue === SearchCategory.ALL
      ? totalCount > searchOffset + searchLimit
      : (categoryValue === SearchCategory.TRACKS && tracksCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.ALBUMS && albumsCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.ARTISTS && artistsCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.PLAYLISTS && playlistsCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.PODCASTS && podcastsCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.EPISODES && episodesCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.PEOPLE && peopleCount > searchOffset + searchLimit) ||
        (categoryValue === SearchCategory.USERS && usersCount > searchOffset + searchLimit);

    const results: SearchResult = {
      query,
      results: {
        tracks: formattedTracks,
        albums: formattedAlbums,
        artists: formattedArtists,
        playlists: formattedPlaylists,
        podcasts: formattedPodcasts,
        episodes: formattedEpisodes,
        people: formattedPeople,
        users: formattedUsers,
      },
      counts: {
        tracks: tracksCount,
        albums: albumsCount,
        artists: artistsCount,
        playlists: playlistsCount,
        podcasts: podcastsCount,
        episodes: episodesCount,
        people: peopleCount,
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
    const querySpecificEnough = query.trim().length >= AUDIUS_IMPORT_MIN_QUERY_LENGTH;
    const canImportAudius =
      env.AUDIUS_BACKGROUND_IMPORT_ENABLED !== 'false' &&
      isTrackSearch &&
      sparseLocalResults &&
      querySpecificEnough &&
      searchOffset === 0;
    const pendingAudiusImport = canImportAudius;

    if (canImportAudius) {
      enqueueAudiusImport(query);
    }

    // True when a background deep import may still be enriching podcasts (the
    // shallow upsert already ran synchronously above for explicit searches).
    const pendingPodcastImport = podcastSyncTriggered;

    res.json({ ...results, pendingAudiusImport, pendingPodcastImport });
  } catch (error) {
    next(error);
  }
};
