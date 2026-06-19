import mongoose, { type FilterQuery, type PipelineStage } from 'mongoose';
import { AlbumModel, type IAlbum } from '../models/Album';
import { ArtistModel, type IArtist } from '../models/Artist';
import { TrackModel } from '../models/Track';
import {
  type CatalogPlaybackOptions,
  playableTrackFilter,
  visibleCatalogFilter,
} from './catalogVisibility';

const PLAYABLE_TRACK_LOOKUP_FIELD = '_playableTracks';

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
): FilterQuery<Record<string, unknown>> {
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

function withPlayableTracksPipeline<T>(
  filter: FilterQuery<T>,
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

function toObjectId(id: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(id);
}

export async function findAlbumsWithPlayableTracks(
  filter: FilterQuery<IAlbum>,
  playbackOptions: CatalogPlaybackOptions,
  page: CatalogPage,
): Promise<unknown[]> {
  return AlbumModel.aggregate<unknown>([
    ...withPlayableTracksPipeline(visibleCatalogFilter(filter), 'albumId', playbackOptions),
    ...paginatedStages(page),
  ]).exec();
}

export async function countAlbumsWithPlayableTracks(
  filter: FilterQuery<IAlbum>,
  playbackOptions: CatalogPlaybackOptions,
): Promise<number> {
  const result = await AlbumModel.aggregate<{ total: number }>([
    ...withPlayableTracksPipeline(visibleCatalogFilter(filter), 'albumId', playbackOptions),
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
      visibleCatalogFilter({ _id: toObjectId(id) }),
      'albumId',
      playbackOptions,
    ),
    { $limit: 1 },
  ]).exec();

  return albums[0] ?? null;
}

export async function findArtistsWithPlayableTracks(
  filter: FilterQuery<IArtist>,
  playbackOptions: CatalogPlaybackOptions,
  page: CatalogPage,
): Promise<unknown[]> {
  return ArtistModel.aggregate<unknown>([
    ...withPlayableTracksPipeline(visibleCatalogFilter(filter), 'artistId', playbackOptions),
    ...paginatedStages(page),
  ]).exec();
}

export async function countArtistsWithPlayableTracks(
  filter: FilterQuery<IArtist>,
  playbackOptions: CatalogPlaybackOptions,
): Promise<number> {
  const result = await ArtistModel.aggregate<{ total: number }>([
    ...withPlayableTracksPipeline(visibleCatalogFilter(filter), 'artistId', playbackOptions),
    { $count: 'total' },
  ]).exec();

  return result[0]?.total ?? 0;
}

export async function findOneArtistWithPlayableTracks(
  id: string,
  playbackOptions: CatalogPlaybackOptions,
): Promise<unknown | null> {
  const artists = await ArtistModel.aggregate<unknown>([
    ...withPlayableTracksPipeline(
      visibleCatalogFilter({ _id: toObjectId(id) }),
      'artistId',
      playbackOptions,
    ),
    { $limit: 1 },
  ]).exec();

  return artists[0] ?? null;
}
