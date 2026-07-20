import mongoose, { type QueryFilter, type PipelineStage } from 'mongoose';
import { AlbumModel } from '../models/Album';
import { ArtistModel } from '../models/CatalogEntity';
import { PlaylistModel } from '../models/Playlist';
import { PlaylistTrackModel } from '../models/PlaylistTrack';
import { TrackModel } from '../models/Track';
import { playableTrackFilter } from './catalogVisibility';

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
): QueryFilter<Record<string, unknown>> {
  return {
    $and: [
      playableTrackFilter<Record<string, unknown>>({}),
      { $expr: { $eq: [`$${relationField}`, '$$containerId'] } },
    ],
  };
}

function playableTrackLookup(
  relationField: 'albumId' | 'artistId',
): PipelineStage.Lookup {
  return {
    $lookup: {
      from: TrackModel.collection.name,
      let: { containerId: { $toString: '$_id' } },
      pipeline: [
        { $match: playableTrackRelationFilter(relationField) },
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
): PipelineStage[] {
  return [
    { $match: filter },
    playableTrackLookup(relationField),
    { $match: { [`${PLAYABLE_TRACK_LOOKUP_FIELD}.0`]: { $exists: true } } },
    { $project: { [PLAYABLE_TRACK_LOOKUP_FIELD]: 0 } },
  ];
}

function playlistTrackLookup(): PipelineStage.Lookup {
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
                    playableTrackFilter<Record<string, unknown>>({}),
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
): PipelineStage[] {
  return [
    { $match: filter },
    playlistTrackLookup(),
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
  return { ...filter, isAvailable: { $ne: false } };
}

export async function findAlbumsWithPlayableTracks(
  filter: CatalogMatchFilter,
  page: CatalogPage,
): Promise<unknown[]> {
  return AlbumModel.aggregate<unknown>([
    ...withPlayableTracksPipeline(availableAlbumFilter(filter), 'albumId'),
    ...paginatedStages(page),
  ]).exec();
}

export async function countAlbumsWithPlayableTracks(
  filter: CatalogMatchFilter,
): Promise<number> {
  const result = await AlbumModel.aggregate<{ total: number }>([
    ...withPlayableTracksPipeline(availableAlbumFilter(filter), 'albumId'),
    { $count: 'total' },
  ]).exec();

  return result[0]?.total ?? 0;
}

export async function findOneAlbumWithPlayableTracks(
  id: string,
): Promise<unknown | null> {
  const albums = await AlbumModel.aggregate<unknown>([
    ...withPlayableTracksPipeline(
      availableAlbumFilter({ _id: toObjectId(id) }),
      'albumId',
    ),
    { $limit: 1 },
  ]).exec();

  return albums[0] ?? null;
}

export async function findArtistsWithPlayableTracks(
  filter: CatalogMatchFilter,
  page: CatalogPage,
): Promise<unknown[]> {
  // aggregate() bypasses the discriminator's `type` scoping — match it explicitly.
  return ArtistModel.aggregate<unknown>([
    ...withPlayableTracksPipeline({ ...filter, type: 'artist' }, 'artistId'),
    ...paginatedStages(page),
  ]).exec();
}

export async function countArtistsWithPlayableTracks(
  filter: CatalogMatchFilter,
): Promise<number> {
  // aggregate() bypasses the discriminator's `type` scoping — match it explicitly.
  const result = await ArtistModel.aggregate<{ total: number }>([
    ...withPlayableTracksPipeline({ ...filter, type: 'artist' }, 'artistId'),
    { $count: 'total' },
  ]).exec();

  return result[0]?.total ?? 0;
}

export async function findOneArtistWithPlayableTracks(
  id: string,
): Promise<unknown | null> {
  // aggregate() bypasses the discriminator's `type` scoping — match it explicitly.
  const artists = await ArtistModel.aggregate<unknown>([
    ...withPlayableTracksPipeline(
      { _id: toObjectId(id), type: 'artist' },
      'artistId',
    ),
    { $limit: 1 },
  ]).exec();

  return artists[0] ?? null;
}

export async function findPlaylistsWithPlayableTracks(
  filter: CatalogMatchFilter,
  page: CatalogPage,
): Promise<unknown[]> {
  return PlaylistModel.aggregate<unknown>([
    ...withPlayablePlaylistTracksPipeline(filter),
    ...paginatedStages(page),
  ]).exec();
}

export async function countPlaylistsWithPlayableTracks(
  filter: CatalogMatchFilter,
): Promise<number> {
  const result = await PlaylistModel.aggregate<{ total: number }>([
    ...withPlayablePlaylistTracksPipeline(filter),
    { $count: 'total' },
  ]).exec();

  return result[0]?.total ?? 0;
}
