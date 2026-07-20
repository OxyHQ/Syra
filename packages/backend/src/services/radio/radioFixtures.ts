import mongoose from 'mongoose';
import { PlaylistVisibility } from '@syra/shared-types';
import { AlbumModel } from '../../models/Album';
import { ArtistModel } from '../../models/CatalogEntity';
import { CatalogRelationModel } from '../../models/CatalogRelation';
import { UserLibraryModel } from '../../models/Library';
import { PlaylistModel } from '../../models/Playlist';
import { PlaylistTrackModel } from '../../models/PlaylistTrack';
import { TrackModel, type ITrack } from '../../models/Track';
import { UserTasteProfileModel } from '../../models/UserTasteProfile';

/**
 * Catalogue builders shared by the radio suites.
 *
 * Radio is only interesting against a populated catalogue, and every radio test
 * needs the same handful of rows (a playable track by a known artist, a struck
 * track, an explicit track). Building them here keeps each test about the one
 * behaviour it is asserting instead of about Mongoose required fields.
 */

export async function makeArtist(
  over: Partial<{ name: string; genres: string[]; popularity: number; terminated: boolean }> = {}
): Promise<string> {
  const artist = await ArtistModel.create({
    name: over.name ?? 'Test Artist',
    genres: over.genres ?? [],
    popularity: over.popularity ?? 50,
    terminated: over.terminated ?? false,
    source: 'upload',
  });
  return artist._id.toString();
}

export interface TrackOverrides {
  title?: string;
  artistId?: string;
  artistName?: string;
  albumId?: string;
  genre?: string;
  mood?: string;
  tags?: string[];
  popularity?: number;
  isExplicit?: boolean;
  isAvailable?: boolean;
  copyrightRemoved?: boolean;
  trackNumber?: number;
}

export async function makeTrack(over: TrackOverrides = {}): Promise<ITrack> {
  return TrackModel.create({
    title: over.title ?? 'Test Track',
    artistId: over.artistId ?? new mongoose.Types.ObjectId().toString(),
    artistName: over.artistName ?? 'Test Artist',
    albumId: over.albumId,
    duration: 180,
    genre: over.genre,
    mood: over.mood,
    tags: over.tags ?? [],
    popularity: over.popularity ?? 50,
    isExplicit: over.isExplicit ?? false,
    isAvailable: over.isAvailable ?? true,
    copyrightRemoved: over.copyrightRemoved ?? false,
    trackNumber: over.trackNumber,
    source: 'upload',
  });
}

export async function makeAlbum(
  over: Partial<{ title: string; artistId: string; artistName: string; genre: string[]; isAvailable: boolean }> = {}
): Promise<string> {
  const album = await AlbumModel.create({
    title: over.title ?? 'Test Album',
    artistId: over.artistId ?? new mongoose.Types.ObjectId().toString(),
    artistName: over.artistName ?? 'Test Artist',
    releaseDate: '2026-01-01',
    coverArt: new mongoose.Types.ObjectId().toString(),
    genre: over.genre ?? [],
    isAvailable: over.isAvailable ?? true,
    source: 'upload',
  });
  return album._id.toString();
}

export async function makePlaylist(
  over: Partial<{ name: string; ownerOxyUserId: string; visibility: PlaylistVisibility }> = {}
): Promise<string> {
  const playlist = await PlaylistModel.create({
    name: over.name ?? 'Test Playlist',
    ownerOxyUserId: over.ownerOxyUserId ?? 'owner-1',
    ownerUsername: 'owner',
    visibility: over.visibility ?? PlaylistVisibility.PUBLIC,
  });
  return playlist._id.toString();
}

export async function addPlaylistTracks(playlistId: string, trackIds: string[]): Promise<void> {
  await PlaylistTrackModel.insertMany(
    trackIds.map((trackId, order) => ({
      playlistId: new mongoose.Types.ObjectId(playlistId),
      trackId,
      addedAt: new Date().toISOString(),
      order,
    }))
  );
}

export async function relate(
  kind: 'track' | 'artist',
  sourceId: string,
  targetId: string,
  score: number
): Promise<void> {
  await CatalogRelationModel.create({ kind, sourceId, targetId, score, coCount: 10 });
}

export async function makeTasteProfile(
  oxyUserId: string,
  genres: { key: string; weight: number }[],
  artists: { key: string; weight: number }[]
): Promise<void> {
  await UserTasteProfileModel.create({ oxyUserId, genres, artists, totalSignal: 100 });
}

export async function makeLibrary(oxyUserId: string, likedTracks: string[]): Promise<void> {
  await UserLibraryModel.create({ oxyUserId, likedTracks });
}
