import { Request, Response, NextFunction } from 'express';
import { and, asc, count, eq } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import {
  PlaylistVisibility,
  SearchCategory,
  SearchResult,
  SearchUser,
  type Album,
  type Artist,
  type Playlist,
  type SearchPerson,
  type Track,
} from '@syra/shared-types';
import { getAccountDisplayName } from '@oxyhq/core';
import type { User } from '@oxyhq/core';
import { env } from '../config/env';
import { getDb, isPostgresConnected } from '../db/postgres';
import { albums, catalogEntities, tracks } from '../db/schema/catalog';
import { playlists } from '../db/schema/library';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import {
  countAlbumsWithPlayableTracks,
  countArtistsWithPlayableTracks,
  countPlaylistsWithPlayableTracks,
  descNullsLast,
  findAlbumsWithPlayableTracks,
  findArtistsWithPlayableTracks,
  findPlaylistsWithPlayableTracks,
  imageFirst,
} from '../db/catalog/containers';
import { toAlbumDtos, toArtistDtos, toPlaylistDtos, toTrackDtos } from '../db/catalog/hydrate';
import { textSearch } from '../db/catalog/search';
import { playableTrackFilter } from '../db/catalog/visibility';
import { PodcastModel } from '../models/Podcast';
import { hiddenShowEpisodeFilter } from '../utils/podcastDiscovery';
import { EpisodeModel } from '../models/Episode';
import { serializePodcast, serializeEpisode, type PodcastDocument, type EpisodeDocument } from '../services/podcasts/podcastSerializers';
import { loadShowArtworkByPodcastId } from '../services/podcasts/episodeShowArtwork';
import { enrichPersons, makeOxyUsersFetcher } from '../services/podcasts/resolvePersons';
import { toPersonLike } from './entityProfile.controller';
import { syncPodcastSearch } from '../services/podcasts/podcastBackgroundImport';
import { parseBoundedLimit, parseOffset } from '../utils/reqParams';
import { logger } from '../utils/logger';
import { oxy } from '../oxyClient';

/** Shortest query worth triggering a background podcast directory import for. */
const MIN_IMPORT_QUERY_LENGTH = 3;
const HEADER_PREVIEW_LIMIT = 5;
const SEARCH_LIMIT_MAX = 50;

/**
 * A regex for the PODCAST half, which is still Mongoose.
 *
 * The catalog half no longer compiles one at all — it matches through
 * `search_vector` (`db/catalog/search.ts`). Podcasts and episodes are Task 12's
 * vertical and their own tables carry `search_vector` columns already, so this
 * function and its two call sites disappear when that task lands. It is kept
 * ESCAPED in the meantime: `/api/search` is public, and an unescaped
 * `new RegExp(req.query.q)` over a collection scan is a ReDoS.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** How each catalog category is ordered — the shelf orderings, in one place. */
const TRACK_ORDER = [
  imageFirst(tracks.coverArtId),
  descNullsLast(tracks.popularity),
  descNullsLast(tracks.createdAt),
];
const ALBUM_ORDER = [descNullsLast(albums.popularity), descNullsLast(albums.releaseDate)];
const ARTIST_ORDER = [
  imageFirst(catalogEntities.imageId),
  descNullsLast(catalogEntities.popularity),
  descNullsLast(catalogEntities.statsFollowers),
];
const PLAYLIST_ORDER = [
  imageFirst(playlists.coverArtId),
  descNullsLast(playlists.followers),
  descNullsLast(playlists.createdAt),
];

/**
 * `catalog_entities` rows of `type = 'person'` matching the query.
 *
 * Persons and artists share one table, so `type` is written out — Mongoose's
 * discriminator injected it into `PersonModel.find()` and an aggregation would
 * not have had it at all. Ordered by name, exactly as the Mongo read was.
 */
async function findPeople(query: string, offset: number, limit: number) {
  return getDb()
    .select(publicColumns(catalogEntities, PROTECTED_COLUMNS_BY_TABLE))
    .from(catalogEntities)
    .where(
      and(eq(catalogEntities.type, 'person'), textSearch(catalogEntities.searchVector, query))
    )
    .orderBy(asc(catalogEntities.name))
    .offset(offset)
    .limit(limit);
}

async function countPeople(query: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(catalogEntities)
    .where(
      and(eq(catalogEntities.type, 'person'), textSearch(catalogEntities.searchVector, query))
    );
  return row?.total ?? 0;
}

/** Playable tracks matching the query, most relevant shelf order first. */
async function findTracks(query: string, offset: number, limit: number) {
  return getDb()
    .select(publicColumns(tracks, PROTECTED_COLUMNS_BY_TABLE))
    .from(tracks)
    .where(and(playableTrackFilter(), textSearch(tracks.searchVector, query)))
    .orderBy(...TRACK_ORDER)
    .offset(offset)
    .limit(limit);
}

async function countTracks(query: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(tracks)
    .where(and(playableTrackFilter(), textSearch(tracks.searchVector, query)));
  return row?.total ?? 0;
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
    if (!isPostgresConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { q, category = 'all', limit = 20, offset = 0 } = req.query;
    const query = (q as string) || '';
    const searchCategory = category as SearchCategory;
    const searchLimit = parseBoundedLimit(limit, 20, SEARCH_LIMIT_MAX);
    const searchOffset = parseOffset(offset);

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

    const trimmed = query.trim();
    // The PODCAST half only — the catalog half matches through `search_vector`.
    const searchRegex = new RegExp(escapeRegex(trimmed), 'i');

    /**
     * Every category is a DTO promise now, not a document promise.
     *
     * The four catalog categories used to be `CatalogAggregateDoc` so the Mongo
     * formatters could be typed against `_id`; they are serialized by
     * `db/catalog/hydrate` here, which names its own input and output. `people`
     * is `SearchPerson[]` for the same reason — it goes through `enrichPersons`,
     * whose input `PersonLike` a drizzle row does not satisfy, so the mapping is
     * explicit (`toPersonLike`) rather than implicit and silent.
     *
     * `podcasts`/`episodes` keep `unknown`: they go to the podcast serializers,
     * which is Task 12's boundary, not this one.
     */
    const searchPromises: {
      tracks?: Promise<[Track[], number]>;
      albums?: Promise<[Album[], number]>;
      artists?: Promise<[Artist[], number]>;
      playlists?: Promise<[Playlist[], number]>;
      podcasts?: Promise<[unknown[], number]>;
      episodes?: Promise<[unknown[], number]>;
      people?: Promise<[SearchPerson[], number]>;
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
      const trackFind = findTracks(trimmed, searchOffset, searchLimit).then(toTrackDtos);
      searchPromises.tracks = isPreviewSearch
        ? trackFind.then((found) => [found, found.length])
        : Promise.all([trackFind, countTracks(trimmed)]);
    }

    // Search albums
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.ALBUMS) {
      const albumMatches = textSearch(albums.searchVector, trimmed);
      const albumFind = findAlbumsWithPlayableTracks(albumMatches, {
        orderBy: ALBUM_ORDER,
        offset: searchOffset,
        limit: searchLimit,
      }).then(toAlbumDtos);
      searchPromises.albums = isPreviewSearch
        ? albumFind.then((found) => [found, found.length])
        : Promise.all([albumFind, countAlbumsWithPlayableTracks(albumMatches)]);
    }

    // Search artists
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.ARTISTS) {
      const artistMatches = textSearch(catalogEntities.searchVector, trimmed);
      const artistFind = findArtistsWithPlayableTracks(artistMatches, {
        orderBy: ARTIST_ORDER,
        offset: searchOffset,
        limit: searchLimit,
      }).then(toArtistDtos);
      searchPromises.artists = isPreviewSearch
        ? artistFind.then((found) => [found, found.length])
        : Promise.all([artistFind, countArtistsWithPlayableTracks(artistMatches)]);
    }

    // Search playlists (only public playlists for now)
    if (categoryValue === SearchCategory.ALL || categoryValue === SearchCategory.PLAYLISTS) {
      /**
       * `description` is in the stored vector already —
       * `to_tsvector('english', name || ' ' || coalesce(description, ''))` — so
       * the Mongo `$or` over two fields is ONE match here, and the `coalesce`
       * is what stops a null description erasing the whole vector.
       */
      const playlistMatches = and(
        eq(playlists.visibility, PlaylistVisibility.PUBLIC),
        textSearch(playlists.searchVector, trimmed)
      );
      const playlistFind = findPlaylistsWithPlayableTracks(playlistMatches, {
        orderBy: PLAYLIST_ORDER,
        offset: searchOffset,
        limit: searchLimit,
      }).then(toPlaylistDtos);
      searchPromises.playlists = isPreviewSearch
        ? playlistFind.then((found) => [found, found.length])
        : Promise.all([playlistFind, countPlaylistsWithPlayableTracks(playlistMatches)]);
    }

    // Podcast enrichment. For an explicit podcasts search we AWAIT the shallow
    // upsert of directory candidates so they appear in THIS response (instant,
    // like the old discover); the heavy feed import runs in the background. For
    // 'all' we enrich in the background so the aggregate search stays fast.
    // `syncPodcastSearch` is bounded + throttled and never hangs/throws.
    let podcastSyncTriggered = false;
    if (
      env.PODCAST_BULK_IMPORT_ENABLED !== 'false' &&
      query.trim().length >= MIN_IMPORT_QUERY_LENGTH &&
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
      const personFind = findPeople(trimmed, searchOffset, searchLimit).then((rows) =>
        enrichPersons(rows.map(toPersonLike), makeOxyUsersFetcher(oxy))
      );
      searchPromises.people = isPreviewSearch
        ? personFind.then((found) => [found, found.length])
        : Promise.all([personFind, countPeople(trimmed)]);
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
      searchPromises.tracks ?? Promise.resolve<[Track[], number]>([[], 0]),
      searchPromises.albums ?? Promise.resolve<[Album[], number]>([[], 0]),
      searchPromises.artists ?? Promise.resolve<[Artist[], number]>([[], 0]),
      searchPromises.playlists ?? Promise.resolve<[Playlist[], number]>([[], 0]),
      searchPromises.podcasts ?? Promise.resolve<[unknown[], number]>([[], 0]),
      searchPromises.episodes ?? Promise.resolve<[unknown[], number]>([[], 0]),
      searchPromises.people ?? Promise.resolve<[SearchPerson[], number]>([[], 0]),
      searchPromises.users ?? Promise.resolve<[SearchUser[], number]>([[], 0]),
    ]);

    /**
     * Each catalog category is ALREADY a DTO list — serialized inside its own
     * promise, so the page's `image_assets` lookup happens once per category
     * instead of once per request for a category that was not asked for. The
     * category guards that used to sit here are gone with the formatters: a
     * category nobody asked for resolved to `[[], 0]` above, and mapping an
     * empty list is the same answer with one fewer way to disagree.
     */
    const formattedTracks = tracksResult[0];
    const formattedAlbums = albumsResult[0];
    const formattedArtists = artistsResult[0];
    const formattedPlaylists = playlistsResult[0];
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
    const formattedPeople = peopleResult[0];
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

    // True when a background deep import may still be enriching podcasts (the
    // shallow upsert already ran synchronously above for explicit searches).
    const pendingPodcastImport = podcastSyncTriggered;

    res.json({ ...results, pendingPodcastImport });
  } catch (error) {
    next(error);
  }
};
