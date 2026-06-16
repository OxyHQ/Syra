import React, { useState } from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { webViewStyle } from '@/utils/webStyles';
import { useMediaQuery } from 'react-responsive';
import { useUIStore } from '@/stores/uiStore';
import { useLibraryCollections } from '@/hooks/useLibraryCollections';
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

  const [isExpanded, setIsExpanded] = useState(!isMobile);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'Playlists' | 'Artists' | 'Albums' | 'Podcasts'>('Playlists');
  const isFullscreen = fullscreenPanel === 'library';

  // Library data from the shared React Query layer. Derived from the
  // `['library']` membership cache, so optimistic like/save/follow toggles
  // anywhere keep the sidebar in sync without a local fetch effect.
  const { playlists, savedAlbums, followedArtists, likedTracksCount, loading, error } =
    useLibraryCollections();

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
  // `overflowY` is a react-native-web value; this sidebar only scrolls on web.
  container: webViewStyle({
    height: '100%',
    overflowY: 'auto',
    ...Platform.select({
      default: {
        flex: 1,
      },
    }),
  }),
});
