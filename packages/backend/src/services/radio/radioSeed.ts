import mongoose from 'mongoose';
import type { RadioSeed } from '@syra/shared-types';
import { AlbumModel } from '../../models/Album';
import { ArtistModel } from '../../models/CatalogEntity';
import { UserLibraryModel } from '../../models/Library';
import { PlaylistModel } from '../../models/Playlist';
import { PlaylistTrackModel } from '../../models/PlaylistTrack';
import { TrackModel } from '../../models/Track';
import { UserTasteProfileModel } from '../../models/UserTasteProfile';
import { canViewPlaylist, playableTrackFilter } from '../../utils/catalogVisibility';
import { normalizeImageRef } from '../../utils/musicHelpers';
import { orderByIds } from '../recommendations/taste';

/**
 * Seed resolution: turning "play radio from X" into the material the candidate
 * pools query with.
 *
 * A station is never generated from the seed id directly — it is generated from
 * the *sets* below. That indirection is what lets one pool implementation serve
 * all seven seed types: an album station and a playlist station differ only in
 * how their track/artist/genre sets were derived, never in how they are
 * programmed. Resolution is also where a seed is validated: `null` means the
 * caller asked for something that does not exist or that they may not read, and
 * the route turns that into a 404.
 */
export interface SeedResolution {
  /** Collaborative-filtering sources of `kind: 'track'`. */
  seedTrackIds: string[];
  /** Collaborative-filtering sources of `kind: 'artist'`. */
  seedArtistIds: string[];
  genres: string[];
  moods: string[];
  /** Free-form descriptors, used by the content-similarity pool and tag Jaccard. */
  tags: string[];
  title: string;
  subtitle: string;
  imageUrl?: string;
  /**
   * True when the station's own identity came from the listener's taste profile.
   * Seed-anchored stations are `false` even for a signed-in listener: their
   * basis is the seed, and taste only re-orders the candidates.
   */
  personalized: boolean;
}

/** Most popular tracks of an artist used to anchor an artist station. */
const ARTIST_SEED_TRACK_LIMIT = 10;

/** Tracks of an album station's seed set. */
const ALBUM_SEED_TRACK_LIMIT = 20;

/** Playlist entries read to derive a playlist station's seed set. */
const PLAYLIST_SEED_TRACK_LIMIT = 50;

/** Top artists of the taste profile used to anchor a personalised station. */
const USER_SEED_ARTIST_LIMIT = 15;

/** Top genres of the taste profile used to anchor a personalised station. */
const USER_SEED_GENRE_LIMIT = 8;

/** Liked tracks sampled as collaborative-filtering sources for a personalised station. */
const USER_SEED_LIKED_TRACK_LIMIT = 20;

function isObjectId(value: string): boolean {
  return mongoose.Types.ObjectId.isValid(value);
}

/** Distinct, non-empty values in first-seen order. */
function distinct(values: (string | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** "deep house" → "Deep House", for genre/mood station titles. */
function toTitleCase(value: string): string {
  return value.replace(/(^|\s)([a-z])/g, (_match, boundary: string, letter: string) =>
    `${boundary}${letter.toUpperCase()}`
  );
}

/** The taste weights sorted by descending weight, strongest `limit` first. */
function topTasteKeys(weights: { key: string; weight: number }[], limit: number): string[] {
  return weights
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((entry) => entry.key);
}

/**
 * Resolve a station seed, or `null` when it does not exist or the caller may not
 * read it. `oxyUserId` is `undefined` for a guest.
 */
export async function resolveRadioSeed(
  seed: RadioSeed,
  oxyUserId: string | undefined
): Promise<SeedResolution | null> {
  switch (seed.seedType) {
    case 'track':
      return resolveTrackSeed(seed.seedId);
    case 'artist':
      return resolveArtistSeed(seed.seedId);
    case 'album':
      return resolveAlbumSeed(seed.seedId);
    case 'playlist':
      return resolvePlaylistSeed(seed.seedId, oxyUserId);
    case 'genre':
      return resolveGenreSeed(seed.seedId);
    case 'mood':
      return resolveMoodSeed(seed.seedId);
    case 'user':
      return resolveUserSeed(oxyUserId);
  }
}

async function resolveTrackSeed(seedId: string): Promise<SeedResolution | null> {
  if (!isObjectId(seedId)) return null;

  const track = await TrackModel.findOne(playableTrackFilter({ _id: seedId })).lean();
  if (!track) return null;

  return {
    seedTrackIds: [track._id.toString()],
    seedArtistIds: [track.artistId],
    genres: distinct([track.genre]),
    moods: distinct([track.mood]),
    tags: distinct(track.tags ?? []),
    title: `${track.title} Radio`,
    subtitle: `Based on ${track.title} by ${track.artistName}`,
    imageUrl: normalizeImageRef(track.coverArt),
    personalized: false,
  };
}

async function resolveArtistSeed(seedId: string): Promise<SeedResolution | null> {
  if (!isObjectId(seedId)) return null;

  const artist = await ArtistModel.findOne({ _id: seedId, terminated: { $ne: true } }).lean();
  if (!artist) return null;

  const tracks = await TrackModel.find(playableTrackFilter({ artistId: seedId }))
    .sort({ popularity: -1 })
    .limit(ARTIST_SEED_TRACK_LIMIT)
    .lean();

  // An artist row carries `genres` only once it has been enriched. Falling back
  // to the genres of its own top tracks keeps a fresh artist's station from
  // having no content signal at all, which would leave it to the popularity
  // backstop alone.
  const genres = artist.genres?.length
    ? distinct(artist.genres)
    : distinct(tracks.map((track) => track.genre));

  return {
    seedTrackIds: tracks.map((track) => track._id.toString()),
    seedArtistIds: [artist._id.toString()],
    genres,
    moods: [],
    tags: [],
    title: `${artist.name} Radio`,
    subtitle: `Based on ${artist.name}`,
    imageUrl: normalizeImageRef(artist.image),
    personalized: false,
  };
}

async function resolveAlbumSeed(seedId: string): Promise<SeedResolution | null> {
  if (!isObjectId(seedId)) return null;

  const album = await AlbumModel.findOne({ _id: seedId, isAvailable: { $ne: false } }).lean();
  if (!album) return null;

  const tracks = await TrackModel.find(playableTrackFilter({ albumId: seedId }))
    .sort({ trackNumber: 1 })
    .limit(ALBUM_SEED_TRACK_LIMIT)
    .lean();

  return {
    seedTrackIds: tracks.map((track) => track._id.toString()),
    seedArtistIds: distinct([album.artistId, ...tracks.map((track) => track.artistId)]),
    genres: album.genre?.length ? distinct(album.genre) : distinct(tracks.map((track) => track.genre)),
    moods: distinct(tracks.map((track) => track.mood)),
    tags: distinct(tracks.flatMap((track) => track.tags ?? [])),
    title: `${album.title} Radio`,
    subtitle: `Based on ${album.title} by ${album.artistName}`,
    imageUrl: normalizeImageRef(album.coverArt),
    personalized: false,
  };
}

async function resolvePlaylistSeed(
  seedId: string,
  oxyUserId: string | undefined
): Promise<SeedResolution | null> {
  if (!isObjectId(seedId)) return null;

  const playlist = await PlaylistModel.findById(seedId).lean();
  if (!playlist) return null;

  // A private playlist is not a public station: the same rule the playlists API
  // enforces decides whether this caller may seed from it.
  if (!canViewPlaylist(playlist, oxyUserId)) return null;

  const entries = await PlaylistTrackModel.find({ playlistId: seedId })
    .sort({ order: 1 })
    .limit(PLAYLIST_SEED_TRACK_LIMIT)
    .lean();

  const orderedIds = entries.map((entry) => entry.trackId).filter(isObjectId);
  const tracks = orderedIds.length
    ? orderByIds(
        await TrackModel.find(playableTrackFilter({ _id: { $in: orderedIds } })).lean(),
        orderedIds
      )
    : [];

  return {
    seedTrackIds: tracks.map((track) => track._id.toString()),
    seedArtistIds: distinct(tracks.map((track) => track.artistId)),
    genres: distinct(tracks.map((track) => track.genre)),
    moods: distinct(tracks.map((track) => track.mood)),
    tags: distinct(tracks.flatMap((track) => track.tags ?? [])),
    title: `${playlist.name} Radio`,
    subtitle: `Based on ${playlist.name}`,
    imageUrl: normalizeImageRef(playlist.coverArt),
    personalized: false,
  };
}

async function resolveGenreSeed(seedId: string): Promise<SeedResolution | null> {
  const genre = seedId.trim().toLowerCase();
  if (!genre) return null;

  // Refuse to mint a station for a genre nothing playable carries — otherwise a
  // typo yields a plausible-looking station filled entirely by the popularity
  // backstop.
  const exists = await TrackModel.exists(playableTrackFilter({ genre }));
  if (!exists) return null;

  return {
    seedTrackIds: [],
    seedArtistIds: [],
    genres: [genre],
    moods: [],
    tags: [],
    title: `${toTitleCase(genre)} Radio`,
    subtitle: `A mix of ${genre} tracks`,
    personalized: false,
  };
}

async function resolveMoodSeed(seedId: string): Promise<SeedResolution | null> {
  const mood = seedId.trim().toLowerCase();
  if (!mood) return null;

  const exists = await TrackModel.exists(playableTrackFilter({ mood }));
  if (!exists) return null;

  return {
    seedTrackIds: [],
    seedArtistIds: [],
    genres: [],
    moods: [mood],
    tags: [],
    title: `${toTitleCase(mood)} Radio`,
    subtitle: `Tracks that feel ${mood}`,
    personalized: false,
  };
}

/**
 * The listener's own station. Never `null`: a guest, or a signed-in listener
 * with no learned taste yet, gets an empty seed set and `personalized: false`,
 * which the pools fill from global popularity. Cold start is a labelling
 * question here, not an error.
 */
async function resolveUserSeed(oxyUserId: string | undefined): Promise<SeedResolution> {
  const [profile, library] = oxyUserId
    ? await Promise.all([
        UserTasteProfileModel.findOne({ oxyUserId }).lean(),
        UserLibraryModel.findOne({ oxyUserId }).select({ likedTracks: 1 }).lean(),
      ])
    : [null, null];

  const topArtists = topTasteKeys(profile?.artists ?? [], USER_SEED_ARTIST_LIMIT).filter(isObjectId);
  const topGenres = topTasteKeys(profile?.genres ?? [], USER_SEED_GENRE_LIMIT);

  // Most recently liked rather than a random draw: liked tracks are appended, so
  // the tail is the freshest signal — and it keeps the station reproducible.
  const likedTrackIds = (library?.likedTracks ?? []).filter(isObjectId).slice(-USER_SEED_LIKED_TRACK_LIMIT);

  const personalized = topGenres.length > 0 || topArtists.length > 0;

  return {
    seedTrackIds: likedTrackIds,
    seedArtistIds: topArtists,
    genres: topGenres,
    moods: [],
    tags: [],
    title: 'Your Daily Mix',
    subtitle: personalized ? 'Based on what you listen to' : 'Popular on Syra right now',
    personalized,
  };
}

/**
 * Listener taste as the scorer consumes it: affinities normalised to 0..1
 * against the listener's own strongest weight, so a heavy listener and a light
 * one are scored on the same scale.
 */
export interface RadioTasteSignal {
  artistAffinity: Record<string, number>;
  genreAffinity: Record<string, number>;
}

const EMPTY_TASTE: RadioTasteSignal = { artistAffinity: {}, genreAffinity: {} };

function normaliseWeights(weights: { key: string; weight: number }[]): Record<string, number> {
  const max = Math.max(0, ...weights.map((entry) => entry.weight));
  if (max <= 0) return {};

  const out: Record<string, number> = {};
  for (const entry of weights) {
    if (entry.weight > 0) {
      out[entry.key] = entry.weight / max;
    }
  }
  return out;
}

/** Load the listener's taste profile. A guest, or an unknown user, scores flat. */
export async function loadRadioTaste(oxyUserId: string | undefined): Promise<RadioTasteSignal> {
  if (!oxyUserId) return EMPTY_TASTE;

  const profile = await UserTasteProfileModel.findOne({ oxyUserId }).lean();
  if (!profile) return EMPTY_TASTE;

  return {
    artistAffinity: normaliseWeights(profile.artists ?? []),
    genreAffinity: normaliseWeights(profile.genres ?? []),
  };
}
