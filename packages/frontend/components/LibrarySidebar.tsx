import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { useMediaQuery } from 'react-responsive';
import { useUIStore } from '@/stores/uiStore';
import { useOxy } from '@oxyhq/services';
import { Playlist, Album, Artist } from '@syra/shared-types';
import { musicService } from '@/services/musicService';
import { libraryService } from '@/services/libraryService';
import { LibrarySidebarCollapsed } from './LibrarySidebar/LibrarySidebarCollapsed';
import { LibrarySidebarExpanded } from './LibrarySidebar/LibrarySidebarExpanded';

/**
 * Library Sidebar Component
 * Container component that manages state and conditionally renders:
 * - Collapsed view (icon-only)
 * - Expanded view with list mode (normal sidebar)
 * - Expanded view with grid mode (fullscreen)
 */
export const LibrarySidebar: React.FC = () => {
  const isMobile = useMediaQuery({ maxWidth: 767 });
  const { fullscreenPanel, toggleFullscreen } = useUIStore();
  const { isAuthenticated } = useOxy();

  const [isExpanded, setIsExpanded] = useState(!isMobile);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'Playlists' | 'Artists' | 'Albums' | 'Podcasts'>('Playlists');
  const isFullscreen = fullscreenPanel === 'library';

  // Library data state - fetched regardless of expanded/collapsed state
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [savedAlbums, setSavedAlbums] = useState<Album[]>([]);
  const [followedArtists, setFollowedArtists] = useState<Artist[]>([]);
  const [likedTracksCount, setLikedTracksCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch library data - always fetch regardless of expanded/collapsed state
  useEffect(() => {
    const fetchLibraryData = async () => {
      if (!isAuthenticated) {
        setLoading(false);
        setPlaylists([]);
        setSavedAlbums([]);
        setFollowedArtists([]);
        setLikedTracksCount(0);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        // Fetch all library data in parallel
        const [playlistsResponse, likedTracksResponse, libraryResponse] = await Promise.all([
          musicService.getUserPlaylists().catch((err) => {
            console.error('[LibrarySidebar] Error fetching playlists:', err);
            return { playlists: [], total: 0 };
          }),
          libraryService.getLikedTracks().catch((err) => {
            console.error('[LibrarySidebar] Error fetching liked tracks:', err);
            return { tracks: [], total: 0, oxyUserId: '' };
          }),
          libraryService.getUserLibrary().catch((err) => {
            console.error('[LibrarySidebar] Error fetching library:', err);
            return { savedAlbums: [], followedArtists: [], likedTracks: [], oxyUserId: '' };
          }),
        ]);

        setPlaylists(playlistsResponse.playlists);
        setLikedTracksCount(likedTracksResponse.total);

        // Fetch full album and artist objects from IDs
        const albumPromises = (libraryResponse.savedAlbums || []).slice(0, 50).map((albumId: string) =>
          musicService.getAlbumById(albumId).catch(() => null)
        );
        const artistPromises = (libraryResponse.followedArtists || []).slice(0, 50).map((artistId: string) =>
          musicService.getArtistById(artistId).catch(() => null)
        );

        const [albums, artists] = await Promise.all([
          Promise.all(albumPromises),
          Promise.all(artistPromises),
        ]);

        setSavedAlbums(albums.filter((album): album is Album => album !== null));
        setFollowedArtists(artists.filter((artist): artist is Artist => artist !== null));
      } catch (err) {
        console.error('[LibrarySidebar] Error fetching library data:', err);
        setError('Failed to load library data');
      } finally {
        setLoading(false);
      }
    };

    fetchLibraryData();
  }, [isAuthenticated]);

  // Hide on mobile
  if (isMobile) {
    return null;
  }

  // Determine display mode for expanded view
  const displayMode = isFullscreen ? 'grid' : 'list';

  return (
    <View style={styles.container}>
      {!isExpanded ? (
        <LibrarySidebarCollapsed 
          onExpand={() => setIsExpanded(true)}
          playlists={playlists}
          savedAlbums={savedAlbums}
          followedArtists={followedArtists}
          likedTracksCount={likedTracksCount}
          loading={loading}
        />
      ) : (
        <LibrarySidebarExpanded
          displayMode={displayMode}
          searchQuery={searchQuery}
          activeFilter={activeFilter}
          isFullscreen={isFullscreen}
          onFullscreen={() => toggleFullscreen('library')}
          onCollapse={() => setIsExpanded(false)}
          onSearchChange={setSearchQuery}
          onFilterChange={setActiveFilter}
          playlists={playlists}
          savedAlbums={savedAlbums}
          followedArtists={followedArtists}
          likedTracksCount={likedTracksCount}
          loading={loading}
          error={error}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    height: '100%',
    overflowY: 'auto' as any,
    ...Platform.select({
      default: {
        flex: 1,
      },
    }),
  },
});
