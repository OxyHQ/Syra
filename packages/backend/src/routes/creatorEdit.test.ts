import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { clear, connect, disconnect } from '../test/mongo';
import { TrackModel } from '../models/Track';
import { AlbumModel } from '../models/Album';
import { ArtistModel } from '../models/CatalogEntity';
import { PodcastModel } from '../models/Podcast';
import { EpisodeModel } from '../models/Episode';
import {
  countAlbumsWithPlayableTracks,
  findOneAlbumWithPlayableTracks,
} from '../utils/playableContainers';
import { playableTrackFilter } from '../utils/catalogVisibility';
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

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

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

/** An artist profile owned by OWNER_ID, plus a track and album hanging off it. */
async function seedOwnedCatalog() {
  const artist = await ArtistModel.create({
    name: 'The Owner',
    source: 'upload',
    ownerOxyUserId: OWNER_ID,
  });
  const artistId = artist._id.toString();

  const track = await TrackModel.create({
    title: 'Original Title',
    artistId,
    artistName: 'The Owner',
    duration: 180,
    source: 'upload',
  });

  const album = await AlbumModel.create({
    title: 'Original Album',
    artistId,
    artistName: 'The Owner',
    releaseDate: '2026-01-01',
    coverArt: 'cover-id',
  });

  return { artist, artistId, track, album };
}

describe('PATCH /api/tracks/:id', () => {
  it('lets the owner edit the title', async () => {
    const { track } = await seedOwnedCatalog();

    await withRouter('/api/tracks', tracksRoutes, OWNER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/tracks/${track._id.toString()}`, {
        title: 'Corrected Title',
      });

      expect(response.status).toBe(200);
      const stored = await TrackModel.findById(track._id).lean();
      expect(stored?.title).toBe('Corrected Title');
    });
  });

  it('rejects a non-owner with 403 and leaves the track unchanged', async () => {
    const { track } = await seedOwnedCatalog();

    await withRouter('/api/tracks', tracksRoutes, INTRUDER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/tracks/${track._id.toString()}`, {
        title: 'Hijacked Title',
      });

      expect(response.status).toBe(403);
      const stored = await TrackModel.findById(track._id).lean();
      expect(stored?.title).toBe('Original Title');
    });
  });

  it('ignores fields outside the update whitelist', async () => {
    const { track, artistId } = await seedOwnedCatalog();

    await withRouter('/api/tracks', tracksRoutes, OWNER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/tracks/${track._id.toString()}`, {
        title: 'Corrected Title',
        artistId: 'some-other-artist',
        playCount: 999999,
        copyrightRemoved: true,
      });

      expect(response.status).toBe(200);
      const stored = await TrackModel.findById(track._id).lean();
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
      const response = await patch(`${baseUrl}/api/tracks/${track._id.toString()}`, {
        isAvailable: false,
      });

      expect(response.status).toBe(200);
      const stored = await TrackModel.findById(track._id).lean();
      expect(stored?.isAvailable).toBe(false);
      // Unpublishing is NOT a takedown: the copyright fields stay untouched.
      expect(stored?.copyrightRemoved).not.toBe(true);
      expect(stored?.removedAt).toBeUndefined();
    });
  });
});

describe('PATCH /api/albums/:id', () => {
  it('lets the owner edit the title', async () => {
    const { album } = await seedOwnedCatalog();

    await withRouter('/api/albums', albumsRoutes, OWNER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/albums/${album._id.toString()}`, {
        title: 'Corrected Album',
      });

      expect(response.status).toBe(200);
      const stored = await AlbumModel.findById(album._id).lean();
      expect(stored?.title).toBe('Corrected Album');
    });
  });

  it('rejects a non-owner with 403 and leaves the album unchanged', async () => {
    const { album } = await seedOwnedCatalog();

    await withRouter('/api/albums', albumsRoutes, INTRUDER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/albums/${album._id.toString()}`, {
        title: 'Hijacked Album',
      });

      expect(response.status).toBe(403);
      const stored = await AlbumModel.findById(album._id).lean();
      expect(stored?.title).toBe('Original Album');
    });
  });
});

describe('album unpublish (container-only)', () => {
  it('hides the album from listings while its tracks stay individually discoverable', async () => {
    const { album, artistId, track } = await seedOwnedCatalog();
    await TrackModel.updateOne({ _id: track._id }, { albumId: album._id.toString() });

    expect(await countAlbumsWithPlayableTracks({ artistId })).toBe(1);

    await withRouter('/api/albums', albumsRoutes, OWNER_ID, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/albums/${album._id.toString()}/unpublish`,
        { method: 'POST' },
      );
      expect(response.status).toBe(200);
    });

    // The container is gone from listings...
    expect(await countAlbumsWithPlayableTracks({ artistId })).toBe(0);
    expect(await findOneAlbumWithPlayableTracks(album._id.toString())).toBeNull();

    // ...but the track itself is untouched and still individually playable. This is the
    // whole point of option B: retiring an album must not silently retire its songs.
    const storedTrack = await TrackModel.findById(track._id).lean();
    expect(storedTrack?.isAvailable).not.toBe(false);
    expect(await TrackModel.countDocuments(playableTrackFilter({ artistId }))).toBe(1);
  });

  it('republishes losslessly', async () => {
    const { album, artistId, track } = await seedOwnedCatalog();
    await TrackModel.updateOne({ _id: track._id }, { albumId: album._id.toString() });

    await withRouter('/api/albums', albumsRoutes, OWNER_ID, async (baseUrl) => {
      const albumUrl = `${baseUrl}/api/albums/${album._id.toString()}`;
      await fetch(`${albumUrl}/unpublish`, { method: 'POST' });
      expect((await fetch(`${albumUrl}/publish`, { method: 'POST' })).status).toBe(200);
    });

    expect(await countAlbumsWithPlayableTracks({ artistId })).toBe(1);
    expect((await AlbumModel.findById(album._id).lean())?.title).toBe('Original Album');
  });

  it('rejects a non-owner unpublishing an album', async () => {
    const { album } = await seedOwnedCatalog();

    await withRouter('/api/albums', albumsRoutes, INTRUDER_ID, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/albums/${album._id.toString()}/unpublish`,
        { method: 'POST' },
      );

      expect(response.status).toBe(403);
      expect((await AlbumModel.findById(album._id).lean())?.isAvailable).not.toBe(false);
    });
  });

  it('treats a pre-existing album with no isAvailable field as available', async () => {
    const { album, artistId, track } = await seedOwnedCatalog();
    await TrackModel.updateOne({ _id: track._id }, { albumId: album._id.toString() });
    // Simulate a document written before the field existed — no backfill should be needed.
    await AlbumModel.collection.updateOne({ _id: album._id }, { $unset: { isAvailable: '' } });

    expect(await countAlbumsWithPlayableTracks({ artistId })).toBe(1);
  });
});

describe('PATCH /api/artists/me', () => {
  it('lets the owner edit their bio', async () => {
    await seedOwnedCatalog();

    await withRouter('/api/artists', artistsAuthRoutes, OWNER_ID, async (baseUrl) => {
      const response = await patch(`${baseUrl}/api/artists/me`, { bio: 'A new bio.' });

      expect(response.status).toBe(200);
      const stored = await ArtistModel.findOne({ ownerOxyUserId: OWNER_ID }).lean();
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
      const stored = await ArtistModel.findOne({ ownerOxyUserId: OWNER_ID }).lean();
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
      const stored = await ArtistModel.findOne({ ownerOxyUserId: OWNER_ID }).lean();
      expect(stored?.bio).toBeUndefined();
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
