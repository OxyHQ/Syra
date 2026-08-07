import { uuidv7 } from '@oxyhq/db';
import { PlaylistVisibility } from '@syra/shared-types';
import { CatalogRelationModel } from '../../models/CatalogRelation';
import { UserTasteProfileModel } from '../../models/UserTasteProfile';
import { getDb } from '../../db/postgres';
import { albums, catalogEntities, imageAssets, tracks } from '../../db/schema/catalog';
import { playlistTracks, playlists, userLikedTracks } from '../../db/schema/library';
import { setAlbumGenres } from '../../db/catalog/genres';

/**
 * Catalogue builders shared by the radio suites.
 *
 * Radio is only interesting against a populated catalogue, and every radio test
 * needs the same handful of rows (a playable track by a known artist, a struck
 * track, an explicit track). Building them here keeps each test about the one
 * behaviour it is asserting instead of about required columns.
 *
 * ## Every builder now creates its own parents
 *
 * The Mongo versions defaulted `artistId` to a fresh, DANGLING `ObjectId` —
 * fine when nothing checked, and impossible now: `tracks.artist_id` and
 * `albums.artist_id` are real foreign keys, and `albums.cover_art_id` is a NOT
 * NULL foreign key. So `makeTrack` and `makeAlbum` create the artist (and the
 * cover asset) they need when the caller does not supply one. A test that
 * wants a specific artist still passes `artistId` and gets exactly that.
 *
 * `CatalogRelation` and `UserTasteProfile` are still Mongoose — they belong to
 * Task 15's vertical — so a radio suite needs BOTH `test/mongo` and
 * `test/postgres` hooks until that lands. `UserLibrary` was in that sentence
 * until Task 11; {@link makeLibrary} writes `user_liked_tracks` now.
 */

/** An `image_assets` row, because `albums.cover_art_id` is NOT NULL. */
async function makeImageAsset(): Promise<string> {
  const id = uuidv7();
  await getDb().insert(imageAssets).values({
    id,
    s3Key: `fixtures/${id}.jpg`,
    filename: `${id}.jpg`,
    contentType: 'image/jpeg',
    byteSize: 1024,
    width: 640,
    height: 640,
    ownerType: 'album',
  });
  return id;
}

export async function makeArtist(
  over: Partial<{ name: string; genres: string[]; popularity: number; terminated: boolean }> = {}
): Promise<string> {
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      // Unique by default: `catalog_entities_artist_name_key_key` is a unique
      // partial index on `name_key`, so two fixtures both called "Test Artist"
      // would collide. The Mongo collection had the same index and the same
      // hazard; it simply was not exercised, because most suites made one.
      name: over.name ?? 'Test Artist',
      nameKey: over.name ? over.name.toLowerCase() : `test-artist-${uuidv7()}`,
      genres: over.genres ?? [],
      popularity: over.popularity ?? 50,
      terminated: over.terminated ?? false,
      source: 'upload',
    })
    .returning({ id: catalogEntities.id });

  if (!artist) throw new Error('makeArtist: insert returned no row');
  return artist.id;
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

/** The columns a radio suite asserts on. Not the whole row — see `publicColumns`. */
export interface FixtureTrack {
  id: string;
  artistId: string;
  genre: string | null;
  mood: string | null;
  tags: string[];
  popularity: number;
}

export async function makeTrack(over: TrackOverrides = {}): Promise<FixtureTrack> {
  const artistId = over.artistId ?? (await makeArtist({ name: over.artistName }));

  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: over.title ?? 'Test Track',
      artistId,
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
    })
    .returning({
      id: tracks.id,
      artistId: tracks.artistId,
      genre: tracks.genre,
      mood: tracks.mood,
      tags: tracks.tags,
      popularity: tracks.popularity,
    });

  if (!track) throw new Error('makeTrack: insert returned no row');
  return track;
}

export async function makeAlbum(
  over: Partial<{
    title: string;
    artistId: string;
    artistName: string;
    genre: string[];
    isAvailable: boolean;
  }> = {}
): Promise<string> {
  const artistId = over.artistId ?? (await makeArtist({ name: over.artistName }));

  const [album] = await getDb()
    .insert(albums)
    .values({
      title: over.title ?? 'Test Album',
      artistId,
      artistName: over.artistName ?? 'Test Artist',
      releaseDate: '2026-01-01',
      coverArtId: await makeImageAsset(),
      isAvailable: over.isAvailable ?? true,
      source: 'upload',
    })
    .returning({ id: albums.id });

  if (!album) throw new Error('makeAlbum: insert returned no row');

  if (over.genre?.length) {
    await setAlbumGenres(getDb(), album.id, over.genre);
  }

  return album.id;
}

export async function makePlaylist(
  over: Partial<{ name: string; ownerOxyUserId: string; visibility: PlaylistVisibility }> = {}
): Promise<string> {
  const [playlist] = await getDb()
    .insert(playlists)
    .values({
      name: over.name ?? 'Test Playlist',
      ownerOxyUserId: over.ownerOxyUserId ?? 'owner-1',
      ownerUsername: 'owner',
      visibility: over.visibility ?? PlaylistVisibility.PUBLIC,
    })
    .returning({ id: playlists.id });

  if (!playlist) throw new Error('makePlaylist: insert returned no row');
  return playlist.id;
}

export async function addPlaylistTracks(playlistId: string, trackIds: string[]): Promise<void> {
  if (trackIds.length === 0) return;

  await getDb()
    .insert(playlistTracks)
    .values(
      trackIds.map((trackId, order) => ({
        playlistId,
        trackId,
        addedAt: new Date(),
        position: order,
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

/**
 * Liked tracks for one listener, in the order given.
 *
 * Inserted one at a time rather than in one `values([...])` batch: the order is
 * load-bearing (`radioSeed`'s user seed reads the FRESHEST likes off the tail
 * of `created_at`), and a batch insert would give every row the same
 * `default now()` — which orders them arbitrarily and is exactly the kind of
 * fixture that cannot tell a correct ordering from a broken one.
 */
export async function makeLibrary(oxyUserId: string, likedTracks: string[]): Promise<void> {
  for (const [index, trackId] of likedTracks.entries()) {
    await getDb()
      .insert(userLikedTracks)
      .values({ oxyUserId, trackId, createdAt: new Date(Date.now() + index) });
  }
}
