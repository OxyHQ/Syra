import { libraryService } from './libraryService';
import { api } from '@/utils/api';
import type { Track } from '@syra/shared-types';

jest.mock('@/utils/api', () => ({
  api: {
    get: jest.fn(),
    post: jest.fn(),
    clearCacheByPrefix: jest.fn(),
  },
}));

const mockApiGet = api.get as jest.MockedFunction<typeof api.get>;
const mockApiPost = api.post as jest.MockedFunction<typeof api.post>;
const mockClearCacheByPrefix = api.clearCacheByPrefix as jest.MockedFunction<typeof api.clearCacheByPrefix>;

const track: Track = {
  id: 'track-1',
  title: 'Track One',
  artistId: 'artist-1',
  artistName: 'Artist One',
  duration: 180,
  isExplicit: false,
  isAvailable: true,
  source: 'cc',
  status: 'ready',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('libraryService HTTP cache coherence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches library membership with the linked HTTP cache disabled', async () => {
    mockApiGet.mockResolvedValueOnce({
      data: {
        likedTracks: ['track-1', 123],
        savedAlbums: [],
        followedArtists: [],
        playlists: ['playlist-1'],
      },
    });

    const result = await libraryService.getLibrary();

    expect(mockApiGet).toHaveBeenCalledWith('/library', undefined, { cache: false });
    expect(result).toEqual({
      likedTracks: ['track-1'],
      savedAlbums: [],
      followedArtists: [],
      savedPlaylists: ['playlist-1'],
    });
  });

  it('fetches liked track objects with the linked HTTP cache disabled', async () => {
    mockApiGet.mockResolvedValueOnce({ data: { tracks: [track], total: 1 } });

    const result = await libraryService.getLikedTracks({ limit: 20, offset: 0 });

    expect(mockApiGet).toHaveBeenCalledWith('/library/tracks', { limit: 20, offset: 0 }, { cache: false });
    expect(result.total).toBe(1);
    expect(result.tracks[0]).toEqual(track);
  });

  it('clears cached library GETs after successful like mutations', async () => {
    mockApiPost.mockResolvedValueOnce({ data: { ok: true, likedTracks: ['track-1'] } });

    const result = await libraryService.likeTrack('track-1');

    expect(mockApiPost).toHaveBeenCalledWith('/library/tracks/track-1/like');
    expect(mockClearCacheByPrefix).toHaveBeenCalledWith('GET:/library');
    expect(result).toEqual({ ok: true, likedTracks: ['track-1'] });
  });

  it('rejects invalid mutation responses instead of reconciling stale cache state', async () => {
    mockApiPost.mockResolvedValueOnce({ data: { likedTracks: ['track-1'] } });

    await expect(libraryService.likeTrack('track-1')).rejects.toThrow('Invalid library mutation response');
    expect(mockClearCacheByPrefix).not.toHaveBeenCalled();
  });
});
