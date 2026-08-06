import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { and, count, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { normalizeNameKey } from '@syra/shared-types';
import { clear, connect, disconnect } from '../test/mongo';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { albums, catalogEntities, imageAssets, tracks } from '../db/schema/catalog';
import { PodcastModel } from '../models/Podcast';
import { EpisodeModel } from '../models/Episode';
import {
  countAlbumsWithPlayableTracks,
  findOneAlbumWithPlayableTracks,
} from '../db/catalog/containers';
import { playableTrackFilter } from '../db/catalog/visibility';
import tracksRoutes from './tracks.routes';
import albumsRoutes from './albums.routes';
import artistsAuthRoutes from './artists.auth.routes';
import podcastsRoutes from './podcasts.routes';
import episodesRoutes from './episodes.routes';
import searchRoutes from './search';

/**
 * Creator edit verbs: the happy path, the ownership rejection, and the mass-assignment
 * guard for each entity. The ownership tests are the important half — every handler
 * resolves the owner from the authenticated user plus the STORED document, so a caller
 * must not be able to edit someone else's catalog by knowing its id.
 */

const OWNER_ID = 'oxy-owner-1';
const INTRUDER_ID = 'oxy-intruder-2';

/**
 * BOTH databases, because this file spans TWO verticals: the whole music
 * surface — artist, tracks, albums — is Postgres (Tasks 10c-2 and 10c-3), while
 * podcasts and episodes are Mongoose until Task 12.
 *
 * The two-store artist fixture 10c-2 needed is gone with 10c-3: track and album
 * ownership resolved through `utils/catalogOwnership.ts` (Mongoose) then, which
 * forced ONE artist to exist in both stores under an ObjectId hex — the only id
 * shape both accepted. Ownership is `db/catalog/ownership.ts` now, so the ids
 * here are plain `generatedId()`s like every other fixture on the branch.
 */
beforeAll(async () => {
  await connect();
  await connectDb();
});
afterEach(async () => {
  await clear();
  await clearDb();
});
afterAll(async () => {
  await disconnect();
  await disconnectDb();
});

/** The owner's artist row, read back for the assertions. */
async function readOwnedArtist(ownerOxyUserId: string) {
  const [row] = await getDb()
    .select()
    .from(catalogEntities)
    .where(eq(catalogEntities.ownerOxyUserId, ownerOxyUserId))
    .limit(1);
  return row;
}

/** Serve `router` on an ephemeral port authenticated as `userId`. */
async function withRouter(
  mountPath: string,
  router: express.Router,
  userId: string,
  exercise: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthRequest).user = { id: userId };
    next();
  });
  app.use(mountPath, router);

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });

  try {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected the test server to bind a TCP port');
    }
    await exercise(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function patch(url: string, body: Record<string, unknown>): Promise<globalThis.Response> {
  return fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A stored image asset, because `albums.cover_art_id` is a NOT NULL foreign key. */
async function seedCoverArt(): Promise<string> {
  const id = uuidv7();
  await getDb().insert(imageAssets).values({
    id,
    s3Key: `covers/${id}.jpg`,
    filename: 'cover.jpg',
    contentType: 'image/jpeg',
    byteSize: 1000,
    ownerType: 'album',
  });
  return id;
}

/** Read a track back, by id. */
async function readTrack(trackId: string) {
  const [row] = await getDb().select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
  return row;
}

/** How many of an artist's tracks the catalog would list. */
async function countPlayableTracksOf(artistId: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(tracks)
    .where(and(playableTrackFilter(), eq(tracks.artistId, artistId)));
  return row?.total ?? 0;
}

/** Read an album back, by id. */
async function readAlbum(albumId: string) {
  const [row] = await getDb().select().from(albums).where(eq(albums.id, albumId)).limit(1);
  return row;
}

/** An artist profile owned by OWNER_ID, plus a track and album hanging off it. */
async function seedOwnedCatalog() {
  const name = `The Owner ${uuidv7()}`;

  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name,
      nameKey: normalizeNameKey(name),
      source: 'upload',
      ownerOxyUserId: OWNER_ID,
    })
    .returning({ id: catalogEntities.id });
  if (!artist) throw new Error('seedOwnedCatalog: artist insert returned no row');
  const artistId = artist.id;

  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: 'Original Title',
      artistId,
      artistName: 'The Owner',
      duration: 180,
      source: 'upload',
    })
    .returning({ id: tracks.id });
  if (!track) throw new Error('seedOwnedCatalog: track insert returned no row');

  const [album] = await getDb()
    .insert(albums)
    .values({
      title: 'Original Album',
      artistId,
      artistName: 'The Owner',
      releaseDate: '2026-01-01',
      coverArtId: await seedCoverArt(),
    })
    .returning({ id: albums.id });
  if (!album) throw new Error('seedOwnedCatalog: album insert returned no row');

  return { artistId, track, album };
}

describe('PATCH /api/tracks/:id', () => {
  it('lets the owner edit the title', async () => {
    const { track } = await seedOwnedCatalog();

    await withRouter('/api/tracks', tracksRoutes, OWNER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/tracks/${track.id}`, {
        title: 'Corrected Title',
      });

      expect(response.status).toBe(200);
      const stored = await readTrack(track.id);
      expect(stored?.title).toBe('Corrected Title');
    });
  });

  it('rejects a non-owner with 403 and leaves the track unchanged', async () => {
    const { track } = await seedOwnedCatalog();

    await withRouter('/api/tracks', tracksRoutes, INTRUDER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/tracks/${track.id}`, {
        title: 'Hijacked Title',
      });

      expect(response.status).toBe(403);
      const stored = await readTrack(track.id);
      expect(stored?.title).toBe('Original Title');
    });
  });

  it('ignores fields outside the update whitelist', async () => {
    const { track, artistId } = await seedOwnedCatalog();

    await withRouter('/api/tracks', tracksRoutes, OWNER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/tracks/${track.id}`, {
        title: 'Corrected Title',
        artistId: 'some-other-artist',
        playCount: 999999,
        copyrightRemoved: true,
      });

      expect(response.status).toBe(200);
      const stored = await readTrack(track.id);
      expect(stored?.title).toBe('Corrected Title');
      // Reassigning ownership, inflating stats, or clearing a takedown must not be
      // reachable through the edit endpoint.
      expect(stored?.artistId).toBe(artistId);
      expect(stored?.playCount).not.toBe(999999);
      expect(stored?.copyrightRemoved).not.toBe(true);
    });
  });

  it('lets the owner unpublish via isAvailable', async () => {
    const { track } = await seedOwnedCatalog();

    await withRouter('/api/tracks', tracksRoutes, OWNER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/tracks/${track.id}`, {
        isAvailable: false,
      });

      expect(response.status).toBe(200);
      const stored = await readTrack(track.id);
      expect(stored?.isAvailable).toBe(false);
      // Unpublishing is NOT a takedown: the copyright fields stay untouched.
      expect(stored?.copyrightRemoved).not.toBe(true);
      expect(stored?.removedAt).toBeNull();
    });
  });
});

describe('PATCH /api/albums/:id', () => {
  it('lets the owner edit the title', async () => {
    const { album } = await seedOwnedCatalog();

    await withRouter('/api/albums', albumsRoutes, OWNER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/albums/${album.id}`, {
        title: 'Corrected Album',
      });

      expect(response.status).toBe(200);
      const stored = await readAlbum(album.id);
      expect(stored?.title).toBe('Corrected Album');
    });
  });

  it('rejects a non-owner with 403 and leaves the album unchanged', async () => {
    const { album } = await seedOwnedCatalog();

    await withRouter('/api/albums', albumsRoutes, INTRUDER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/albums/${album.id}`, {
        title: 'Hijacked Album',
      });

      expect(response.status).toBe(403);
      const stored = await readAlbum(album.id);
      expect(stored?.title).toBe('Original Album');
    });
  });
});

describe('album unpublish (container-only)', () => {
  it('hides the album from listings while its tracks stay individually discoverable', async () => {
    const { album, artistId, track } = await seedOwnedCatalog();
    await getDb().update(tracks).set({ albumId: album.id }).where(eq(tracks.id, track.id));

    expect(await countAlbumsWithPlayableTracks(eq(albums.artistId, artistId))).toBe(1);

    await withRouter('/api/albums', albumsRoutes, OWNER_ID, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/albums/${album.id}/unpublish`,
        { method: 'POST' },
      );
      expect(response.status).toBe(200);
    });

    // The container is gone from listings...
    expect(await countAlbumsWithPlayableTracks(eq(albums.artistId, artistId))).toBe(0);
    expect(await findOneAlbumWithPlayableTracks(album.id)).toBeNull();

    // ...but the track itself is untouched and still individually playable. This is the
    // whole point of option B: retiring an album must not silently retire its songs.
    const storedTrack = await readTrack(track.id);
    expect(storedTrack?.isAvailable).not.toBe(false);
    expect(await countPlayableTracksOf(artistId)).toBe(1);
  });

  it('republishes losslessly', async () => {
    const { album, artistId, track } = await seedOwnedCatalog();
    await getDb().update(tracks).set({ albumId: album.id }).where(eq(tracks.id, track.id));

    await withRouter('/api/albums', albumsRoutes, OWNER_ID, async (baseUrl) => {
      const albumUrl = `${baseUrl}/api/albums/${album.id}`;
      await fetch(`${albumUrl}/unpublish`, { method: 'POST' });
      expect((await fetch(`${albumUrl}/publish`, { method: 'POST' })).status).toBe(200);
    });

    expect(await countAlbumsWithPlayableTracks(eq(albums.artistId, artistId))).toBe(1);
    expect((await readAlbum(album.id))?.title).toBe('Original Album');
  });

  it('rejects a non-owner unpublishing an album', async () => {
    const { album } = await seedOwnedCatalog();

    await withRouter('/api/albums', albumsRoutes, INTRUDER_ID, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/albums/${album.id}/unpublish`,
        { method: 'POST' },
      );

      expect(response.status).toBe(403);
      expect((await readAlbum(album.id))?.isAvailable).not.toBe(false);
    });
  });

  /**
   * Was: "treats a pre-existing album with no isAvailable field as available",
   * which `$unset` the field to simulate a document written before it existed.
   *
   * That shape is UNREPRESENTABLE now — `albums.is_available` is
   * `NOT NULL DEFAULT true` — so the Mongo test cannot be translated, and a test
   * that cannot fail is worse than none. What it was really asserting is that an
   * album written WITHOUT the field counts as available and needs no backfill,
   * and that property still holds and is still worth pinning: the column default
   * is what supplies it, and dropping the default would fail this.
   */
  it('an album inserted without isAvailable is available, no backfill needed', async () => {
    const { album, artistId, track } = await seedOwnedCatalog();
    await getDb().update(tracks).set({ albumId: album.id }).where(eq(tracks.id, track.id));

    // The seed never names `isAvailable`; the stored row carries the default.
    expect((await readAlbum(album.id))?.isAvailable).toBe(true);
    expect(await countAlbumsWithPlayableTracks(eq(albums.artistId, artistId))).toBe(1);
  });
});

describe('PATCH /api/artists/me', () => {
  it('lets the owner edit their bio', async () => {
    await seedOwnedCatalog();

    await withRouter('/api/artists', artistsAuthRoutes, OWNER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/artists/me`, { bio: 'A new bio.' });

      expect(response.status).toBe(200);
      const stored = await readOwnedArtist(OWNER_ID);
      expect(stored?.bio).toBe('A new bio.');
    });
  });

  it('never lets a creator self-verify', async () => {
    await seedOwnedCatalog();

    await withRouter('/api/artists', artistsAuthRoutes, OWNER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/artists/me`, {
        bio: 'A new bio.',
        verified: true,
      });

      expect(response.status).toBe(200);
      const stored = await readOwnedArtist(OWNER_ID);
      expect(stored?.bio).toBe('A new bio.');
      // `verified` is a platform-granted badge and is stripped from the payload.
      expect(stored?.verified).not.toBe(true);
    });
  });

  it('does not touch another creator profile when the caller has none', async () => {
    await seedOwnedCatalog();

    await withRouter('/api/artists', artistsAuthRoutes, INTRUDER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/artists/me`, { bio: 'Hijacked bio.' });

      expect(response.status).toBe(404);
      const stored = await readOwnedArtist(OWNER_ID);
      expect(stored?.bio).toBeNull();
    });
  });
});

describe('PATCH /api/podcasts/:id and /api/episodes/:id', () => {
  async function seedOwnedShow() {
    const podcast = await PodcastModel.create({
      title: 'Original Show',
      source: 'syra',
      ownerOxyUserId: OWNER_ID,
    });
    const episode = await EpisodeModel.create({
      podcastId: podcast._id,
      podcastTitle: 'Original Show',
      guid: 'episode-guid-1',
      title: 'Original Episode',
      source: 'syra',
      pubDate: new Date('2026-01-01'),
    });
    return { podcast, episode };
  }

  it('lets the owner edit a Syra-hosted show', async () => {
    const { podcast } = await seedOwnedShow();

    await withRouter('/api/podcasts', podcastsRoutes, OWNER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/podcasts/${podcast._id.toString()}`, {
        title: 'Corrected Show',
      });

      expect(response.status).toBe(200);
      const stored = await PodcastModel.findById(podcast._id).lean();
      expect(stored?.title).toBe('Corrected Show');
    });
  });

  it('rejects a non-owner editing a show with 403', async () => {
    const { podcast } = await seedOwnedShow();

    await withRouter('/api/podcasts', podcastsRoutes, INTRUDER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/podcasts/${podcast._id.toString()}`, {
        title: 'Hijacked Show',
      });

      expect(response.status).toBe(403);
      const stored = await PodcastModel.findById(podcast._id).lean();
      expect(stored?.title).toBe('Original Show');
    });
  });

  it('rejects editing an RSS-mirrored show even by its owner field', async () => {
    const podcast = await PodcastModel.create({
      title: 'Mirrored Show',
      source: 'rss',
      ownerOxyUserId: OWNER_ID,
    });

    await withRouter('/api/podcasts', podcastsRoutes, OWNER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/podcasts/${podcast._id.toString()}`, {
        title: 'Edited Mirror',
      });

      // An RSS mirror is overwritten by the next feed refresh, so edits are refused
      // rather than silently lost.
      expect(response.status).toBe(403);
      const stored = await PodcastModel.findById(podcast._id).lean();
      expect(stored?.title).toBe('Mirrored Show');
    });
  });

  it('lets the owner edit an episode', async () => {
    const { episode } = await seedOwnedShow();

    await withRouter('/api/episodes', episodesRoutes, OWNER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/episodes/${episode._id.toString()}`, {
        title: 'Corrected Episode',
      });

      expect(response.status).toBe(200);
      const stored = await EpisodeModel.findById(episode._id).lean();
      expect(stored?.title).toBe('Corrected Episode');
    });
  });

  it('rejects a non-owner editing an episode with 403', async () => {
    const { episode } = await seedOwnedShow();

    await withRouter('/api/episodes', episodesRoutes, INTRUDER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/episodes/${episode._id.toString()}`, {
        title: 'Hijacked Episode',
      });

      expect(response.status).toBe(403);
      const stored = await EpisodeModel.findById(episode._id).lean();
      expect(stored?.title).toBe('Original Episode');
    });
  });

  it('lets the owner unpublish and republish a show without data loss', async () => {
    const { podcast, episode } = await seedOwnedShow();
    const podcastUrl = `/api/podcasts/${podcast._id.toString()}`;

    await withRouter('/api/podcasts', podcastsRoutes, OWNER_ID, async (baseUrl) => {
      expect((await fetch(`${baseUrl}${podcastUrl}/unpublish`, { method: 'POST' })).status).toBe(200);

      const hidden = await PodcastModel.findById(podcast._id).lean();
      expect(hidden?.status).toBe('unavailable');
      // Soft: the show and its episodes survive, so republishing is lossless.
      expect(hidden?.title).toBe('Original Show');
      expect(await EpisodeModel.countDocuments({ podcastId: podcast._id })).toBe(1);
      // Deliberately does NOT cascade — a directly-linked episode keeps resolving.
      const untouched = await EpisodeModel.findById(episode._id).lean();
      expect(untouched?.status).not.toBe('unavailable');

      expect((await fetch(`${baseUrl}${podcastUrl}/publish`, { method: 'POST' })).status).toBe(200);
      const restored = await PodcastModel.findById(podcast._id).lean();
      expect(restored?.status).toBe('active');
    });
  });

  it('rejects a non-owner unpublishing a show and leaves it active', async () => {
    const { podcast } = await seedOwnedShow();

    await withRouter('/api/podcasts', podcastsRoutes, INTRUDER_ID, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/podcasts/${podcast._id.toString()}/unpublish`,
        { method: 'POST' },
      );

      expect(response.status).toBe(403);
      const stored = await PodcastModel.findById(podcast._id).lean();
      expect(stored?.status).toBe('active');
    });
  });

  it('refuses to republish a platform-removed show', async () => {
    const podcast = await PodcastModel.create({
      title: 'Taken Down',
      source: 'syra',
      ownerOxyUserId: OWNER_ID,
      status: 'removed',
    });

    await withRouter('/api/podcasts', podcastsRoutes, OWNER_ID, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/podcasts/${podcast._id.toString()}/publish`,
        { method: 'POST' },
      );

      // A takedown is not creator-reversible.
      expect(response.status).toBe(409);
      const stored = await PodcastModel.findById(podcast._id).lean();
      expect(stored?.status).toBe('removed');
    });
  });

  it('lets the owner unpublish and republish a single episode', async () => {
    const { episode } = await seedOwnedShow();
    const episodeUrl = `/api/episodes/${episode._id.toString()}`;

    await withRouter('/api/episodes', episodesRoutes, OWNER_ID, async (baseUrl) => {
      expect((await fetch(`${baseUrl}${episodeUrl}/unpublish`, { method: 'POST' })).status).toBe(200);
      expect((await EpisodeModel.findById(episode._id).lean())?.status).toBe('unavailable');

      expect((await fetch(`${baseUrl}${episodeUrl}/publish`, { method: 'POST' })).status).toBe(200);
      const restored = await EpisodeModel.findById(episode._id).lean();
      expect(restored?.status).toBe('ready');
      expect(restored?.title).toBe('Original Episode');
    });
  });

  it('rejects a non-owner unpublishing an episode', async () => {
    const { episode } = await seedOwnedShow();

    await withRouter('/api/episodes', episodesRoutes, INTRUDER_ID, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/episodes/${episode._id.toString()}/unpublish`,
        { method: 'POST' },
      );

      expect(response.status).toBe(403);
      expect((await EpisodeModel.findById(episode._id).lean())?.status).not.toBe('unavailable');
    });
  });
});


describe('episode discovery follows the show', () => {
  async function seedShowWithEpisode(status: 'active' | 'unavailable') {
    const podcast = await PodcastModel.create({
      title: 'Discoverable Show',
      source: 'syra',
      ownerOxyUserId: OWNER_ID,
      status,
    });
    const episode = await EpisodeModel.create({
      podcastId: podcast._id,
      podcastTitle: 'Discoverable Show',
      guid: 'discovery-guid-1',
      title: 'Findable Episode',
      source: 'syra',
      status: 'ready',
      pubDate: new Date('2026-01-01'),
    });
    return { podcast, episode };
  }

  it('surfaces an episode of an active show in search', async () => {
    await seedShowWithEpisode('active');

    await withRouter('/api/search', searchRoutes, OWNER_ID, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/search?q=Findable&category=episodes`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Findable Episode');
    });
  });

  it('drops that episode from search once the show is unpublished', async () => {
    await seedShowWithEpisode('unavailable');

    await withRouter('/api/search', searchRoutes, OWNER_ID, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/search?q=Findable&category=episodes`);
      expect(response.status).toBe(200);
      // A hidden show whose episodes still appear in search reads as a bug.
      expect(await response.text()).not.toContain('Findable Episode');
    });
  });

  it('keeps a direct episode link working for a hidden show', async () => {
    const { episode } = await seedShowWithEpisode('unavailable');

    await withRouter('/api/episodes', episodesRoutes, OWNER_ID, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/episodes/${episode._id.toString()}`);

      // Discovery follows the show; addressability does not. A saved link must not die.
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Findable Episode');
    });
  });
});
