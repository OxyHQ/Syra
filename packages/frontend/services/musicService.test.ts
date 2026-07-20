import { musicService } from './musicService';
import { api } from '@/utils/api';
import { PlaylistVisibility, type Album, type Artist, type Playlist, type Track } from '@syra/shared-types';

jest.mock('@/utils/api', () => ({
  api: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

const mockApiGet = api.get as jest.MockedFunction<typeof api.get>;

const track: Track = {
  id: 'track-1',
  title: 'Stream Only Track',
  artistId: 'artist-1',
  artistName: 'Artist One',
  duration: 180,
  isExplicit: false,
  isAvailable: true,
  source: 'upload',
  status: 'ready',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const album: Album = {
  id: 'album-1',
  title: 'Public Album',
  artistId: 'artist-1',
  artistName: 'Artist One',
  releaseDate: '2026-01-01',
  coverArt: '',
  totalTracks: 1,
  totalDuration: 180,
  type: 'album',
  isExplicit: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const artist: Artist = {
  id: 'artist-1',
  name: 'Artist One',
  stats: {
    followers: 0,
    albums: 1,
    tracks: 1,
    totalPlays: 0,
  },
  source: 'upload',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const playlist: Playlist = {
  id: 'playlist-1',
  name: 'Private Playlist',
  ownerOxyUserId: 'user-1',
  ownerUsername: 'nate',
  visibility: PlaylistVisibility.PRIVATE,
  trackCount: 1,
  totalDuration: 180,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('musicService client selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the linked Oxy client for track catalog reads that depend on playback preferences', async () => {
    mockApiGet
      .mockResolvedValueOnce({ data: { tracks: [track], total: 1, hasMore: false } })
      .mockResolvedValueOnce({ data: track })
      .mockResolvedValueOnce({ data: { tracks: [track], total: 1, hasMore: false } });

    await musicService.getTracks({ limit: 1, offset: 0 });
    await musicService.getTrackById('track-1');
    await musicService.searchTracks('nocturne', { limit: 1 });

    expect(mockApiGet).toHaveBeenCalledWith('/tracks', { limit: 1, offset: 0 });
    expect(mockApiGet).toHaveBeenCalledWith('/tracks/track-1');
    expect(mockApiGet).toHaveBeenCalledWith('/tracks/search', { q: 'nocturne', limit: 1 });
  });

  it('uses the linked Oxy client for album, artist, and playlist reads', async () => {
    mockApiGet
      .mockResolvedValueOnce({ data: { albums: [album], total: 1, hasMore: false } })
      .mockResolvedValueOnce({ data: album })
      .mockResolvedValueOnce({ data: { tracks: [track] } })
      .mockResolvedValueOnce({ data: { artists: [artist], total: 1, hasMore: false } })
      .mockResolvedValueOnce({ data: artist })
      .mockResolvedValueOnce({ data: { albums: [album] } })
      .mockResolvedValueOnce({ data: { tracks: [track], total: 1, hasMore: false } })
      .mockResolvedValueOnce({ data: playlist })
      .mockResolvedValueOnce({ data: { tracks: [track], total: 1 } });

    await musicService.getAlbums({ limit: 1 });
    await musicService.getAlbumById('album-1');
    await musicService.getAlbumTracks('album-1');
    await musicService.getArtists({ limit: 1 });
    await musicService.getArtistById('artist-1');
    await musicService.getArtistAlbums('artist-1');
    await musicService.getArtistTracks('artist-1', { limit: 20 });
    await musicService.getPlaylistById('playlist-1');
    await musicService.getPlaylistTracks('playlist-1');

    expect(mockApiGet).toHaveBeenCalledWith('/albums', { limit: 1 });
    expect(mockApiGet).toHaveBeenCalledWith('/albums/album-1');
    expect(mockApiGet).toHaveBeenCalledWith('/albums/album-1/tracks');
    expect(mockApiGet).toHaveBeenCalledWith('/artists', { limit: 1 });
    expect(mockApiGet).toHaveBeenCalledWith('/artists/artist-1');
    expect(mockApiGet).toHaveBeenCalledWith('/artists/artist-1/albums');
    expect(mockApiGet).toHaveBeenCalledWith('/artists/artist-1/tracks', { limit: 20 });
    expect(mockApiGet).toHaveBeenCalledWith('/playlists/playlist-1');
    expect(mockApiGet).toHaveBeenCalledWith('/playlists/playlist-1/tracks');
  });

  it('rejects malformed catalog responses at the API boundary', async () => {
    mockApiGet.mockResolvedValueOnce({ data: { tracks: [track], total: 1 } });

    await expect(musicService.getTracks()).rejects.toThrow('Invalid tracks response');
  });
});
