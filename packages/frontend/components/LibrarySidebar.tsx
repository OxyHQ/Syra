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
  const {
    fullscreenPanel,
    isLibrarySidebarExpanded,
    setLibrarySidebarExpanded,
    toggleFullscreen,
    librarySortOrder,
    setLibrarySortOrder,
  } = useUIStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'All' | 'Playlists' | 'Artists' | 'Albums' | 'Podcasts'>('All');
  const isFullscreen = fullscreenPanel === 'library';

  // Library data from the shared React Query layer. Derived from the
  // `['library']` membership cache, so optimistic like/save/follow toggles
  // anywhere keep the sidebar in sync without a local fetch effect.
  const { playlists, savedAlbums, followedArtists, likedTracksCount, loading, error, retry } =
    useLibraryCollections();

  // Hide on mobile
  if (isMobile) {
    return null;
  }

  // Determine display mode for expanded view
  const displayMode = isFullscreen ? 'grid' : 'list';

  return (
    <View style={styles.container}>
      {!isLibrarySidebarExpanded ? (
        <LibrarySidebarCollapsed 
          onExpand={() => setLibrarySidebarExpanded(true)}
          playlists={playlists}
          savedAlbums={savedAlbums}
          followedArtists={followedArtists}
          likedTracksCount={likedTracksCount}
          loading={loading}
          error={error}
          onRetry={retry}
        />
      ) : (
        <LibrarySidebarExpanded
          displayMode={displayMode}
          searchQuery={searchQuery}
          activeFilter={activeFilter}
          isFullscreen={isFullscreen}
          onFullscreen={() => toggleFullscreen('library')}
          onCollapse={() => setLibrarySidebarExpanded(false)}
          onSearchChange={setSearchQuery}
          onFilterChange={setActiveFilter}
          sortOrder={librarySortOrder}
          onSortOrderChange={setLibrarySortOrder}
          playlists={playlists}
          savedAlbums={savedAlbums}
          followedArtists={followedArtists}
          likedTracksCount={likedTracksCount}
          loading={loading}
          error={error}
          onRetry={retry}
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
