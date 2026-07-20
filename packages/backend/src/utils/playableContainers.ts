import mongoose, { type QueryFilter, type PipelineStage } from 'mongoose';
import { AlbumModel } from '../models/Album';
import { ArtistModel } from '../models/CatalogEntity';
import { PlaylistModel } from '../models/Playlist';
import { PlaylistTrackModel } from '../models/PlaylistTrack';
import { TrackModel } from '../models/Track';
import {
  type CatalogPlaybackOptions,
  playableTrackFilter,
  visibleCatalogFilter,
} from './catalogVisibility';

const PLAYABLE_TRACK_LOOKUP_FIELD = '_playableTracks';
const PLAYABLE_PLAYLIST_TRACK_LOOKUP_FIELD = '_playablePlaylistTracks';

/**
 * A dynamically composed aggregation `$match` filter. These helpers build
 * heterogeneous match objects fed into `aggregate()` pipelines (which mongoose
 * does not model-strict-type), so a general filter is the honest type here.
 */
type CatalogMatchFilter = QueryFilter<Record<string, unknown>>;

export type CatalogSort = Record<string, 1 | -1>;

export interface CatalogPage {
  sort: CatalogSort;
  limit: number;
  offset?: number;
}

function paginatedStages(page: CatalogPage): PipelineStage[] {
  const stages: PipelineStage[] = [
    { $sort: page.sort },
  ];

  if (page.offset && page.offset > 0) {
    stages.push({ $skip: page.offset });
  }

  stages.push({ $limit: page.limit });
  return stages;
}

function playableTrackRelationFilter(
  relationField: 'albumId' | 'artistId',
  playbackOptions: CatalogPlaybackOptions,
): QueryFilter<Record<string, unknown>> {
  return {
    $and: [
      playableTrackFilter<Record<string, unknown>>({}, playbackOptions),
      { $expr: { $eq: [`$${relationField}`, '$$containerId'] } },
    ],
  };
}

function playableTrackLookup(
  relationField: 'albumId' | 'artistId',
  playbackOptions: CatalogPlaybackOptions,
): PipelineStage.Lookup {
  return {
    $lookup: {
      from: TrackModel.collection.name,
      let: { containerId: { $toString: '$_id' } },
      pipeline: [
        { $match: playableTrackRelationFilter(relationField, playbackOptions) },
        { $limit: 1 },
        { $project: { _id: 1 } },
      ],
      as: PLAYABLE_TRACK_LOOKUP_FIELD,
    },
  };
}

function withPlayableTracksPipeline(
  filter: CatalogMatchFilter,
  relationField: 'albumId' | 'artistId',
  playbackOptions: CatalogPlaybackOptions,
): PipelineStage[] {
  return [
    { $match: filter },
    playableTrackLookup(relationField, playbackOptions),
    { $match: { [`${PLAYABLE_TRACK_LOOKUP_FIELD}.0`]: { $exists: true } } },
    { $project: { [PLAYABLE_TRACK_LOOKUP_FIELD]: 0 } },
  ];
}

function playlistTrackLookup(
  playbackOptions: CatalogPlaybackOptions,
): PipelineStage.Lookup {
  return {
    $lookup: {
      from: PlaylistTrackModel.collection.name,
      let: { playlistId: '$_id' },
      pipeline: [
        { $match: { $expr: { $eq: ['$playlistId', '$$playlistId'] } } },
        {
          $lookup: {
            from: TrackModel.collection.name,
            // `PlaylistTrack.trackId` is a string while `Track._id` is an ObjectId, so
            // the two sides must be reconciled. Convert on the LOCAL side (in `let`,
            // evaluated once per playlist-track row) and leave `$_id` a bare field path:
            // that keeps this an `_id` point lookup. Converting the foreign `$_id`
            // instead makes the comparison unindexable and degrades every row into a
            // scan of `tracks`, which is what made playlist-bearing endpoints take 20s+.
            // A malformed id converts to null and simply matches nothing (not playable).
            let: { trackId: { $convert: { input: '$trackId', to: 'objectId', onError: null, onNull: null } } },
            pipeline: [
              {
                $match: {
                  $and: [
                    playableTrackFilter<Record<string, unknown>>({}, playbackOptions),
                    { $expr: { $eq: ['$_id', '$$trackId'] } },
                  ],
                },
              },
              { $limit: 1 },
              { $project: { _id: 1 } },
            ],
            as: PLAYABLE_TRACK_LOOKUP_FIELD,
          },
        },
        { $match: { [`${PLAYABLE_TRACK_LOOKUP_FIELD}.0`]: { $exists: true } } },
        { $limit: 1 },
        { $project: { _id: 1 } },
      ],
      as: PLAYABLE_PLAYLIST_TRACK_LOOKUP_FIELD,
    },
  };
}

function withPlayablePlaylistTracksPipeline(
  filter: CatalogMatchFilter,
  playbackOptions: CatalogPlaybackOptions,
): PipelineStage[] {
  return [
    { $match: visibleCatalogFilter(filter) },
    playlistTrackLookup(playbackOptions),
    { $match: { [`${PLAYABLE_PLAYLIST_TRACK_LOOKUP_FIELD}.0`]: { $exists: true } } },
    { $project: { [PLAYABLE_PLAYLIST_TRACK_LOOKUP_FIELD]: 0 } },
  ];
}

function toObjectId(id: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(id);
}

/**
 * Album visibility: an album is hidden when its creator unpublishes the CONTAINER,
 * independently of whether its tracks are still individually playable.
 *
 * `$ne: false` means "absent counts as available", so existing albums need no backfill.
 * This stays a bare-field condition on the album collection so it lands in the leading
 * `$match` and can use the `isAvailable` index — deliberately NOT an `$expr` or any
 * computed comparison against the looked-up track side, which is what made these
 * pipelines unindexable before.
 */
function availableAlbumFilter(filter: CatalogMatchFilter): CatalogMatchFilter {
  return visibleCatalogFilter({ ...filter, isAvailable: { $ne: false } });
}

export async function findAlbumsWithPlayableTracks(
  filter: CatalogMatchFilter,
  playbackOptions: CatalogPlaybackOptions,
  page: CatalogPage,
): Promise<unknown[]> {
  return AlbumModel.aggregate<unknown>([
    ...withPlayableTracksPipeline(availableAlbumFilter(filter), 'albumId', playbackOptions),
    ...paginatedStages(page),
  ]).exec();
}

export async function countAlbumsWithPlayableTracks(
  filter: CatalogMatchFilter,
  playbackOptions: CatalogPlaybackOptions,
): Promise<number> {
  const result = await AlbumModel.aggregate<{ total: number }>([
    ...withPlayableTracksPipeline(availableAlbumFilter(filter), 'albumId', playbackOptions),
    { $count: 'total' },
  ]).exec();

  return result[0]?.total ?? 0;
}

export async function findOneAlbumWithPlayableTracks(
  id: string,
  playbackOptions: CatalogPlaybackOptions,
): Promise<unknown | null> {
  const albums = await AlbumModel.aggregate<unknown>([
    ...withPlayableTracksPipeline(
      availableAlbumFilter({ _id: toObjectId(id) }),
      'albumId',
      playbackOptions,
    ),
    { $limit: 1 },
  ]).exec();

  return albums[0] ?? null;
}

export async function findArtistsWithPlayableTracks(
  filter: CatalogMatchFilter,
  playbackOptions: CatalogPlaybackOptions,
  page: CatalogPage,
): Promise<unknown[]> {
  // aggregate() bypasses the discriminator's `type` scoping — match it explicitly.
  return ArtistModel.aggregate<unknown>([
    ...withPlayableTracksPipeline(visibleCatalogFilter({ ...filter, type: 'artist' }), 'artistId', playbackOptions),
    ...paginatedStages(page),
  ]).exec();
}

export async function countArtistsWithPlayableTracks(
  filter: CatalogMatchFilter,
  playbackOptions: CatalogPlaybackOptions,
): Promise<number> {
  // aggregate() bypasses the discriminator's `type` scoping — match it explicitly.
  const result = await ArtistModel.aggregate<{ total: number }>([
    ...withPlayableTracksPipeline(visibleCatalogFilter({ ...filter, type: 'artist' }), 'artistId', playbackOptions),
    { $count: 'total' },
  ]).exec();

  return result[0]?.total ?? 0;
}

export async function findOneArtistWithPlayableTracks(
  id: string,
  playbackOptions: CatalogPlaybackOptions,
): Promise<unknown | null> {
  // aggregate() bypasses the discriminator's `type` scoping — match it explicitly.
  const artists = await ArtistModel.aggregate<unknown>([
    ...withPlayableTracksPipeline(
      visibleCatalogFilter({ _id: toObjectId(id), type: 'artist' }),
      'artistId',
      playbackOptions,
    ),
    { $limit: 1 },
  ]).exec();

  return artists[0] ?? null;
}

export async function findPlaylistsWithPlayableTracks(
  filter: CatalogMatchFilter,
  playbackOptions: CatalogPlaybackOptions,
  page: CatalogPage,
): Promise<unknown[]> {
  return PlaylistModel.aggregate<unknown>([
    ...withPlayablePlaylistTracksPipeline(filter, playbackOptions),
    ...paginatedStages(page),
  ]).exec();
}

export async function countPlaylistsWithPlayableTracks(
  filter: CatalogMatchFilter,
  playbackOptions: CatalogPlaybackOptions,
): Promise<number> {
  const result = await PlaylistModel.aggregate<{ total: number }>([
    ...withPlayablePlaylistTracksPipeline(filter, playbackOptions),
    { $count: 'total' },
  ]).exec();

  return result[0]?.total ?? 0;
}
