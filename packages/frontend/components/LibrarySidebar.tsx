import React, { useState } from 'react';
import { View } from 'react-native';
import { useMediaQuery } from 'react-responsive';
import { useUIStore } from '@/stores/uiStore';
import { useLibraryCollections } from '@/hooks/useLibraryCollections';
import { LibrarySidebarCollapsed } from './LibrarySidebar/LibrarySidebarCollapsed';
import { LibrarySidebarExpanded, type LibraryFilter } from './LibrarySidebar/LibrarySidebarExpanded';

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
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>('All');
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

  // `overflow-y` is a web-only property, hence the `web:` variant; this sidebar
  // only scrolls on web.
  return (
    <View className="flex-1 h-full web:overflow-y-auto">
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
