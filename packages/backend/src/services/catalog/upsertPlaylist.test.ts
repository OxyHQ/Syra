import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect, installCatalogImageMirrorMockForTests } from '../../test/mongo';
import { PlaylistModel } from '../../models/Playlist';
import { TrackModel } from '../../models/Track';
import { upsertPlaylist } from './upsertPlaylist';
import { upsertTrack } from './upsertTrack';
import { setCatalogImageMirrorImplementationForTests } from './catalogImageAssets';
import type { ExternalPlaylist, ExternalTrack } from '@syra/shared-types';

beforeAll(connect);
afterEach(async () => {
  installCatalogImageMirrorMockForTests();
  await clear();
});
afterAll(disconnect);

const basePlaylist: ExternalPlaylist = {
  provider: 'audius',
  externalId: 'aud-playlist-001',
  name: 'Night Drive Picks',
  description: 'Late night tracks',
  images: [{ url: 'https://cdn.audius.co/playlist/1000x1000.jpg', width: 1000, height: 1000 }],
  trackExternalIds: ['aud-playlist-track'],
};

async function seedTrack(externalId: string): Promise<void> {
  const external: ExternalTrack = {
    provider: 'audius',
    externalId,
    title: `Track ${externalId}`,
    artists: [{
      name: 'Playlist Artist',
      externalId: 'aud-playlist-artist',
      images: [{ url: 'https://cdn.audius.co/artist/1000x1000.jpg' }],
    }],
    durationSec: 180,
    images: [{ url: `https://cdn.audius.co/${externalId}/1000x1000.jpg` }],
  };
  const { track } = await upsertTrack(external, 'audius');
  if (!track) throw new Error('expected track');
}

describe('upsertPlaylist', () => {
  it('inserts a playlist with internal cover art and linked tracks', async () => {
    await seedTrack('aud-playlist-track');

    const { playlist, created } = await upsertPlaylist(basePlaylist, 'audius');

    expect(created).toBe(true);
    if (!playlist) throw new Error('expected playlist');
    expect(await PlaylistModel.countDocuments()).toBe(1);
    expect(await TrackModel.countDocuments()).toBe(1);
    expect(playlist.coverArt).toMatch(/^[a-f\d]{24}$/i);
    expect(playlist.coverArtSizes?.large?.url).toBe(`/api/images/${playlist.coverArt}`);
    expect(playlist.trackCount).toBe(1);
  });

  it('skips playlists when cover art mirroring fails', async () => {
    await seedTrack('aud-playlist-track');
    setCatalogImageMirrorImplementationForTests(async () => undefined);

    const { playlist, created } = await upsertPlaylist(basePlaylist, 'audius');

    expect(created).toBe(false);
    expect(playlist).toBeNull();
    expect(await PlaylistModel.countDocuments()).toBe(0);
  });
});
