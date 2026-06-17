import { describe, it, expect } from '@jest/globals';
import { searchRefetchInterval, AUDIUS_REFETCH_MS } from '../utils/searchUtils';
import type { SearchResultWithPending } from '../utils/searchUtils';

describe('searchRefetchInterval', () => {
  it('returns AUDIUS_REFETCH_MS when pendingAudiusImport is true and no tracks yet', () => {
    const data: SearchResultWithPending = {
      query: 'jazz',
      results: { tracks: [], albums: [], artists: [], playlists: [], users: [] },
      counts: { tracks: 0, albums: 0, artists: 0, playlists: 0, users: 0, total: 0 },
      hasMore: false,
      offset: 0,
      limit: 20,
      pendingAudiusImport: true,
    };
    expect(searchRefetchInterval(data)).toBe(AUDIUS_REFETCH_MS);
  });

  it('returns false when pendingAudiusImport is false', () => {
    const data: SearchResultWithPending = {
      query: 'jazz',
      results: { tracks: [], albums: [], artists: [], playlists: [], users: [] },
      counts: { tracks: 0, albums: 0, artists: 0, playlists: 0, users: 0, total: 0 },
      hasMore: false,
      offset: 0,
      limit: 20,
      pendingAudiusImport: false,
    };
    expect(searchRefetchInterval(data)).toBe(false);
  });

  it('returns false when pendingAudiusImport is undefined', () => {
    const data: SearchResultWithPending = {
      query: 'jazz',
      results: { tracks: [], albums: [], artists: [], playlists: [], users: [] },
      counts: { tracks: 0, albums: 0, artists: 0, playlists: 0, users: 0, total: 0 },
      hasMore: false,
      offset: 0,
      limit: 20,
    };
    expect(searchRefetchInterval(data)).toBe(false);
  });

  it('returns false when tracks are already present (import already landed)', () => {
    const data: SearchResultWithPending = {
      query: 'jazz',
      results: {
        tracks: [{ id: 't1' } as never],
        albums: [],
        artists: [],
        playlists: [],
        users: [],
      },
      counts: { tracks: 1, albums: 0, artists: 0, playlists: 0, users: 0, total: 1 },
      hasMore: false,
      offset: 0,
      limit: 20,
      pendingAudiusImport: true,
    };
    // Even if server still says pending, stop polling once we have tracks
    expect(searchRefetchInterval(data)).toBe(false);
  });

  it('returns false when data is null/undefined', () => {
    expect(searchRefetchInterval(null)).toBe(false);
    expect(searchRefetchInterval(undefined)).toBe(false);
  });
});
