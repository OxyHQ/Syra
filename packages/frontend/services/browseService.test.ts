import { browseService } from './browseService';
import { api } from '@/utils/api';
import { PlaylistVisibility, type Album, type Artist, type Playlist, type Track } from '@syra/shared-types';

jest.mock('@/utils/api', () => ({
  api: {
    get: jest.fn(),
  },
}));

const mockApiGet = api.get as jest.MockedFunction<typeof api.get>;

const track: Track = {
  id: 'track-1',
  title: 'Direct Audius Track',
  artistId: 'artist-1',
  artistName: 'Artist One',
  duration: 180,
  isExplicit: false,
  isAvailable: true,
  source: 'audius',
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
  source: 'audius',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const playlist: Playlist = {
  id: 'playlist-1',
  name: 'Public Playlist',
  ownerOxyUserId: 'user-1',
  ownerUsername: 'nate',
  visibility: PlaylistVisibility.PUBLIC,
  trackCount: 1,
  totalDuration: 180,
  isPublic: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('browseService client selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the linked Oxy client for home and track-bearing browse reads', async () => {
    mockApiGet
      .mockResolvedValueOnce({
        data: {
          madeForYou: {
            albums: [album],
            playlists: [playlist],
            tracks: [track],
            artists: [artist],
            personalized: true,
          },
          popularAlbums: { albums: [album], total: 1, hasMore: false },
          popularArtists: { artists: [artist], total: 1, hasMore: false },
          tracks: { tracks: [track], total: 1, hasMore: false },
        },
      })
      .mockResolvedValueOnce({ data: { genres: [{ name: 'Electronic', color: '#000000', coverArt: null }] } })
      .mockResolvedValueOnce({ data: { tracks: [track], total: 1, hasMore: false } })
      .mockResolvedValueOnce({ data: { tracks: [track], total: 1, hasMore: false } })
      .mockResolvedValueOnce({ data: { albums: [album], total: 1, hasMore: false } })
      .mockResolvedValueOnce({ data: { artists: [artist], total: 1, hasMore: false } })
      .mockResolvedValueOnce({
        data: {
          albums: [album],
          playlists: [playlist],
          tracks: [track],
          artists: [artist],
          personalized: true,
        },
      })
      .mockResolvedValueOnce({ data: { tracks: [track], total: 1 } });

    await browseService.getHome({ sectionLimit: 4, tracksLimit: 10 });
    await browseService.getGenres();
    await browseService.getGenreTracks('Electronic', { limit: 10 });
    await browseService.getPopularTracks({ limit: 10, offset: 0 });
    await browseService.getPopularAlbums({ limit: 8 });
    await browseService.getPopularArtists({ limit: 8 });
    await browseService.getMadeForYou({ limit: 8 });
    await browseService.getCharts({ limit: 20 });

    expect(mockApiGet).toHaveBeenCalledWith('/browse/home', { sectionLimit: 4, tracksLimit: 10 });
    expect(mockApiGet).toHaveBeenCalledWith('/browse/genres');
    expect(mockApiGet).toHaveBeenCalledWith('/browse/genres/Electronic/tracks', { limit: 10 });
    expect(mockApiGet).toHaveBeenCalledWith('/browse/popular/tracks', { limit: 10, offset: 0 });
    expect(mockApiGet).toHaveBeenCalledWith('/browse/popular/albums', { limit: 8 });
    expect(mockApiGet).toHaveBeenCalledWith('/browse/popular/artists', { limit: 8 });
    expect(mockApiGet).toHaveBeenCalledWith('/browse/made-for-you', { limit: 8 });
    expect(mockApiGet).toHaveBeenCalledWith('/browse/charts', { limit: 20 });
  });

  it('rejects malformed browse responses at the API boundary', async () => {
    mockApiGet.mockResolvedValueOnce({ data: { tracks: [track], total: 1 } });

    await expect(browseService.getPopularTracks()).rejects.toThrow('Invalid popular tracks response');
  });
});
