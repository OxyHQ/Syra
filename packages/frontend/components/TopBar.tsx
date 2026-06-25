import React, { useState } from 'react';
import { StyleSheet, View, Text, Pressable, Platform, ViewStyle, TextInput, Image, ScrollView, GestureResponderEvent, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { webTextStyle, webViewStyle } from '@/utils/webStyles';
import { useRouter, usePathname, useLocalSearchParams, type Href } from 'expo-router';
import { useTheme } from '@oxyhq/bloom/theme';
import { useOxy } from '@oxyhq/services';
import { useQuery } from '@tanstack/react-query';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Avatar from './Avatar';
import { Logo } from './Logo';
import { useMediaQuery } from 'react-responsive';
import { artistService } from '@/services/artistService';
import { searchService } from '@/services/searchService';
import { musicService } from '@/services/musicService';
import { searchRefetchInterval } from '@/utils/searchUtils';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { pickCatalogImageUrl } from '@/utils/pickImage';
import { Album, Artist, Playlist, SearchCategory, SearchUser, Track } from '@syra/shared-types';
import { usePlayerStore } from '@/stores/playerStore';
import { toast } from '@/lib/sonner';

type HeaderSearchItem = {
  key: string;
  section: 'Tracks' | 'Albums' | 'Artists' | 'Playlists' | 'Users';
  title: string;
  subtitle: string;
  href: Href;
  imageUri?: string;
  /**
   * Bare Oxy file ID for user-avatar rows. Rendered through the local Avatar
   * component (and the registered ImageResolver) so the URL is built at the
   * render boundary, not at the call site. Catalog rows use `imageUri` instead.
   */
  avatarId?: string;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  rounded?: boolean;
  onPlay?: () => Promise<void> | void;
};

const albumHref = (id: string): Href => ({ pathname: '/album/[id]', params: { id } });
const artistHref = (id: string): Href => ({ pathname: '/artist/[id]', params: { id } });
const playlistHref = (id: string): Href => ({ pathname: '/playlist/[id]', params: { id } });
const userHref = (username: string): Href => ({ pathname: '/u/[username]', params: { username } });

/**
 * Base visual height of the top bar (excluding the top safe-area inset, which
 * is added on top on native). Shared with the layout so panel height math stays
 * in sync. The web `calc()` in `MainLayout` uses this same value.
 */
export const TOP_BAR_HEIGHT = 64;

/**
 * Top Navigation Bar Component
 * Spotify-like top bar with logo, navigation, search, and user controls
 */
export const TopBar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const { q } = useLocalSearchParams<{ q?: string }>();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { user, isAuthenticated, canUsePrivateApi, showBottomSheet } = useOxy();
  const { playTrackList } = usePlayerStore();
  const isMobile = useMediaQuery({ maxWidth: 767 });
  const [searchQuery, setSearchQuery] = useState(() => (pathname === '/search' && typeof q === 'string' ? q : ''));
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);

  // Whether the signed-in user has an artist profile (decides dashboard vs. register).
  // Only runs while authenticated; when signed out the query is disabled and resolves
  // to no profile.
  const { data: artistProfile } = useQuery({
    queryKey: ['artist', 'me', 'topbar'],
    queryFn: () => artistService.getMyArtistProfile(),
    enabled: canUsePrivateApi && !!user,
  });

  // Clear the status bar / dynamic island on native by padding the bar's
  // content down by the top inset and growing the bar by the same amount. On
  // web `insets.top` is 0, so the bar keeps its base 64px height there.
  const safeAreaStyle: ViewStyle = {
    paddingTop: insets.top,
    height: TOP_BAR_HEIGHT + insets.top,
  };

  // Subtle raised pill behind the active nav icon, derived from the theme.
  const activeButtonStyle: ViewStyle = { ...styles.activeButton, backgroundColor: theme.colors.backgroundTertiary };
  const navIconColor = theme.colors.text;
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 250);
  const hasHeaderSearchQuery = debouncedSearchQuery.trim().length > 0;

  const { data: headerSearchResults, isLoading: isHeaderSearchLoading } = useQuery({
    queryKey: ['search', 'topbar', debouncedSearchQuery],
    queryFn: () => searchService.search(debouncedSearchQuery, {
      category: SearchCategory.ALL,
      limit: 5,
      offset: 0,
    }),
    enabled: !isMobile && hasHeaderSearchQuery,
    staleTime: 1000 * 60 * 5,
    refetchInterval: (query) => searchRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
  });

  const handleHome = () => {
    router.push('/');
  };

  const handleSearch = () => {
    if (isMobile) {
      router.push('/search');
      return;
    }

    setIsSearchOpen(true);
  };

  const handleSearchSubmit = () => {
    setIsSearchOpen(false);
    router.push({
      pathname: '/search',
      params: searchQuery.trim() ? { q: searchQuery.trim() } : {},
    });
  };

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    setIsSearchOpen(true);
    setActiveSearchIndex(-1);
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    setIsSearchOpen(false);
    setActiveSearchIndex(-1);
  };

  const handleBrowse = () => {
    setSearchQuery('');
    setIsSearchOpen(false);
    setActiveSearchIndex(-1);
    router.push('/browse');
  };


  const handleDashboard = () => {
    if (artistProfile) {
      router.push('/artist/dashboard');
    } else {
      // User doesn't have an artist profile, redirect to register
      router.push('/artist/register');
    }
  };

  const navigateFromSearch = (href: Href) => {
    setIsSearchOpen(false);
    setActiveSearchIndex(-1);
    router.push(href);
  };

  const playAlbum = async (albumId: string, albumName?: string) => {
    const { tracks } = await musicService.getAlbumTracks(albumId);
    if (tracks.length > 0) {
      await playTrackList(tracks, 0, { type: 'album', id: albumId, name: albumName });
      return;
    }
    toast.info('No playable tracks available');
  };

  const playPlaylist = async (playlistId: string, playlistName?: string) => {
    const { tracks } = await musicService.getPlaylistTracks(playlistId);
    if (tracks.length > 0) {
      await playTrackList(tracks, 0, { type: 'playlist', id: playlistId, name: playlistName });
      return;
    }
    toast.info('No playable tracks available');
  };

  const playArtist = async (artistId: string, artistName?: string) => {
    const { tracks } = await musicService.getArtistTracks(artistId, { limit: 50 });
    if (tracks.length > 0) {
      await playTrackList(tracks, 0, { type: 'artist', id: artistId, name: artistName });
      return;
    }
    toast.info('No playable tracks available');
  };

  const buildSearchItems = (): HeaderSearchItem[] => {
    const results = headerSearchResults?.results;
    const trimmedQuery = searchQuery.trim();
    const trackItems = (results?.tracks ?? []).slice(0, 4).map((track: Track) => ({
      key: `track-${track.id}`,
      section: 'Tracks' as const,
      title: track.title,
      subtitle: track.artistName,
      href: track.albumId ? albumHref(track.albumId) : artistHref(track.artistId),
      imageUri: pickCatalogImageUrl(track.images, track.coverArt, 'icon', track.coverArtSizes),
      icon: 'music-note-outline' as const,
      onPlay: () => {
        const tracks = results?.tracks ?? [track];
        const startIndex = Math.max(0, tracks.findIndex((item) => item.id === track.id));
        return playTrackList(tracks, startIndex, { type: 'search', name: trimmedQuery });
      },
    }));
    const albumItems = (results?.albums ?? []).slice(0, 3).map((album: Album) => ({
      key: `album-${album.id}`,
      section: 'Albums' as const,
      title: album.title,
      subtitle: album.artistName,
      href: albumHref(album.id),
      imageUri: pickCatalogImageUrl(undefined, album.coverArt, 'icon', album.coverArtSizes),
      icon: 'album' as const,
      onPlay: () => playAlbum(album.id, album.title),
    }));
    const artistItems = (results?.artists ?? []).slice(0, 3).map((artist: Artist) => ({
      key: `artist-${artist.id}`,
      section: 'Artists' as const,
      title: artist.name,
      subtitle: 'Artist',
      href: artistHref(artist.id),
      imageUri: pickCatalogImageUrl(artist.images, artist.image, 'icon', artist.imageSizes),
      icon: 'account-music-outline' as const,
      rounded: true,
      onPlay: () => playArtist(artist.id, artist.name),
    }));
    const playlistItems = (results?.playlists ?? []).slice(0, 2).map((playlist: Playlist) => ({
      key: `playlist-${playlist.id}`,
      section: 'Playlists' as const,
      title: playlist.name,
      subtitle: `Playlist - ${playlist.trackCount || 0} songs`,
      href: playlistHref(playlist.id),
      imageUri: pickCatalogImageUrl(undefined, playlist.coverArt, 'icon', playlist.coverArtSizes),
      icon: 'playlist-music-outline' as const,
      onPlay: () => playPlaylist(playlist.id, playlist.name),
    }));
    const userItems = (results?.users ?? []).slice(0, 2).map((searchUser: SearchUser) => ({
      key: `user-${searchUser.id}`,
      section: 'Users' as const,
      title: searchUser.displayName,
      subtitle: `@${searchUser.username}`,
      href: userHref(searchUser.username),
      avatarId: searchUser.avatar ?? undefined,
      icon: 'account-outline' as const,
      rounded: true,
    }));

    return [...trackItems, ...albumItems, ...artistItems, ...playlistItems, ...userItems];
  };

  const searchItems = buildSearchItems();
  const totalHeaderResults = headerSearchResults?.counts.total ?? 0;
  const selectableSearchCount = totalHeaderResults > 0 ? searchItems.length + 1 : 0;

  const activateSearchSelection = (index: number) => {
    if (index < 0) {
      handleSearchSubmit();
      return;
    }

    if (index >= searchItems.length) {
      handleSearchSubmit();
      return;
    }

    navigateFromSearch(searchItems[index].href);
  };

  const handleSearchKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const key = event.nativeEvent.key;
    const preventDefault = () => {
      event.preventDefault?.();
      // On react-native-web the underlying `nativeEvent` is a DOM KeyboardEvent
      // that also exposes `preventDefault`; native platforms have no such method.
      const domNativeEvent = event.nativeEvent as TextInputKeyPressEventData & {
        preventDefault?: () => void;
      };
      domNativeEvent.preventDefault?.();
    };

    if (key === 'Escape') {
      preventDefault();
      setIsSearchOpen(false);
      setActiveSearchIndex(-1);
      return;
    }

    if (key === 'ArrowDown' && selectableSearchCount > 0) {
      preventDefault();
      setIsSearchOpen(true);
      setActiveSearchIndex((current) => (current < 0 ? 0 : (current + 1) % selectableSearchCount));
      return;
    }

    if (key === 'ArrowUp' && selectableSearchCount > 0) {
      preventDefault();
      setIsSearchOpen(true);
      setActiveSearchIndex((current) => (current <= 0 ? selectableSearchCount - 1 : current - 1));
      return;
    }

    if (key === 'Enter') {
      preventDefault();
      activateSearchSelection(activeSearchIndex);
    }
  };

  const handleSearchItemPlay = async (item: HeaderSearchItem, event: GestureResponderEvent) => {
    event.stopPropagation();
    await item.onPlay?.();
  };

  const renderArtwork = (
    item: HeaderSearchItem,
    showPlayButton: boolean,
  ) => (
    <View
      style={[
        styles.searchResultArtwork,
        {
          backgroundColor: theme.colors.backgroundTertiary,
          borderRadius: item.rounded ? 18 : 6,
        },
      ]}
    >
      {item.avatarId ? (
        <Avatar source={item.avatarId} variant="thumb" size={36} label={item.title} />
      ) : item.imageUri ? (
        <Image source={{ uri: item.imageUri }} style={[styles.searchResultImage, { borderRadius: item.rounded ? 18 : 6 }]} />
      ) : (
        <MaterialCommunityIcons name={item.icon} size={18} color={theme.colors.textSecondary} />
      )}
      {showPlayButton && item.onPlay && (
        <Pressable
          onPress={(event) => handleSearchItemPlay(item, event)}
          style={styles.searchResultPlayOverlay}
          accessibilityRole="button"
          accessibilityLabel={`Play ${item.title}`}
        >
          <View style={[styles.searchResultPlayButton, { backgroundColor: theme.colors.primary }]}>
            <MaterialCommunityIcons name="play" size={18} color={theme.colors.primaryForeground} />
          </View>
        </Pressable>
      )}
    </View>
  );

  const renderSearchResultRow = ({
    item,
    index,
  }: {
    item: HeaderSearchItem;
    index: number;
  }) => {
    const isActive = activeSearchIndex === index;

    return (
      <Pressable
        key={item.key}
        onPress={() => navigateFromSearch(item.href)}
        onHoverIn={() => setActiveSearchIndex(index)}
        style={({ pressed }) => [
          styles.searchResultRow,
          (pressed || isActive) && { backgroundColor: theme.colors.backgroundTertiary },
        ]}
      >
        {renderArtwork(item, isActive)}
        <View style={styles.searchResultText}>
          <Text style={[styles.searchResultTitle, { color: theme.colors.text }]} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={[styles.searchResultSubtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {item.subtitle}
          </Text>
        </View>
      </Pressable>
    );
  };

  const renderSearchSection = (
    title: HeaderSearchItem['section'],
  ) => {
    const sectionItems = searchItems.filter((item) => item.section === title);
    if (sectionItems.length === 0) return null;

    return (
      <View style={styles.searchResultSection}>
        <Text style={[styles.searchResultSectionTitle, { color: theme.colors.textSecondary }]}>{title}</Text>
        {sectionItems.map((item) => renderSearchResultRow({
          item,
          index: searchItems.findIndex((candidate) => candidate.key === item.key),
        }))}
      </View>
    );
  };

  const renderSearchOverlay = () => {
    const totalResults = totalHeaderResults;
    const viewAllIndex = searchItems.length;
    const isViewAllActive = activeSearchIndex === viewAllIndex;

    return (
      <ScrollView
        style={styles.searchOverlay}
        contentContainerStyle={styles.searchOverlayContent}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {isHeaderSearchLoading && (
          <Text style={[styles.searchOverlayStateText, { color: theme.colors.textSecondary }]}>
            Searching...
          </Text>
        )}
        {!isHeaderSearchLoading && totalResults === 0 && (
          <Text style={[styles.searchOverlayStateText, { color: theme.colors.textSecondary }]}>
            No results for &quot;{debouncedSearchQuery}&quot;
          </Text>
        )}
        {!isHeaderSearchLoading && totalResults > 0 && (
          <>
            {renderSearchSection('Tracks')}
            {renderSearchSection('Albums')}
            {renderSearchSection('Artists')}
            {renderSearchSection('Playlists')}
            {renderSearchSection('Users')}
            <Pressable
              onPress={handleSearchSubmit}
              onHoverIn={() => setActiveSearchIndex(viewAllIndex)}
              style={({ pressed }) => [
                styles.viewAllButton,
                (pressed || isViewAllActive) && { backgroundColor: theme.colors.backgroundTertiary },
              ]}
            >
              <Text style={[styles.viewAllText, { color: theme.colors.primary }]}>View all results</Text>
              <MaterialCommunityIcons name="arrow-right" size={18} color={theme.colors.primary} />
            </Pressable>
          </>
        )}
      </ScrollView>
    );
  };

  const renderSearchField = (containerStyle?: ViewStyle, showOverlay = false) => {
    const isExpanded = showOverlay && isSearchOpen && hasHeaderSearchQuery;

    return (
    <View style={styles.searchShell}>
      <View
        style={[
          styles.searchSurface,
          isExpanded && styles.searchSurfaceExpanded,
          {
            backgroundColor: theme.colors.backgroundSecondary,
            borderColor: isExpanded ? theme.colors.border : 'transparent',
          },
        ]}
      >
        <View
          style={[
            styles.searchContainer,
            containerStyle,
          ]}
        >
          <MaterialCommunityIcons name="magnify" size={20} color={theme.colors.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: theme.colors.text }]}
            placeholder="What do you want to play?"
            placeholderTextColor={theme.colors.textSecondary}
            value={searchQuery}
            onFocus={handleSearch}
            onChangeText={handleSearchChange}
            onKeyPress={handleSearchKeyPress}
            onSubmitEditing={handleSearchSubmit}
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={handleClearSearch} accessibilityRole="button" accessibilityLabel="Clear search">
              <MaterialCommunityIcons name="close-circle" size={18} color={theme.colors.textSecondary} />
            </Pressable>
          )}
          <View style={[styles.searchActionSeparator, { backgroundColor: theme.colors.border }]} />
          <Pressable onPress={handleBrowse} accessibilityRole="button" accessibilityLabel="Browse">
            <MaterialCommunityIcons name="view-grid-outline" size={19} color={theme.colors.textSecondary} />
          </Pressable>
        </View>
        {showOverlay && hasHeaderSearchQuery && renderSearchOverlay()}
      </View>
    </View>
    );
  };

  const renderProfileAction = () => (
    isAuthenticated && user ? (
      <Pressable
        style={styles.avatarButton}
        onPress={() => router.push('/settings')}
      >
        <Avatar
          size={32}
          source={user?.avatar ?? undefined}
          variant="thumb"
        />
      </Pressable>
    ) : (
      <Pressable
        style={[styles.loginButton, { backgroundColor: theme.colors.primary }]}
        onPress={() => showBottomSheet?.('OxyAuth')}
      >
        <Text style={[styles.loginText, { color: theme.colors.primaryForeground }]}>Log in</Text>
      </Pressable>
    )
  );

  if (isMobile) {
    return (
      <View style={[styles.container, styles.mobileContainer, safeAreaStyle]}>
        <Pressable onPress={handleHome} style={styles.mobileLogoContainer}>
          <View pointerEvents="none">
            <Logo color={navIconColor} />
          </View>
        </Pressable>
        <View style={styles.mobileRightSection}>
          {renderProfileAction()}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, safeAreaStyle]}>
      {/* Left Section: Logo */}
      <View style={styles.leftSection}>
        <Pressable onPress={handleHome} style={styles.logoContainer}>
          <View pointerEvents="none">
            <Logo color={navIconColor} />
          </View>
        </Pressable>
      </View>

      {/* Center Section: Home & Search Grouped (Centered) */}
      <View style={styles.centerSection}>
        <View style={styles.centerGroup}>
          <Pressable 
            onPress={handleHome}
            style={[styles.iconButton, pathname === '/' && activeButtonStyle]}
          >
            <MaterialCommunityIcons 
              name={pathname === '/' ? 'home' : 'home-outline'} 
              size={24} 
              color={navIconColor} 
            />
          </Pressable>
          
          {!isMobile && (
            <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />
          )}
          
          {renderSearchField(undefined, true)}
        </View>
      </View>

      {/* Right Section: Actions & Profile */}
      <View style={styles.rightSection}>
        {isAuthenticated && (
          <Pressable
            style={[styles.iconButton, pathname.startsWith('/artist') && activeButtonStyle]}
            onPress={handleDashboard}
            accessibilityLabel={artistProfile ? 'Artist Dashboard' : 'Register as Artist'}
          >
            <MaterialCommunityIcons 
              name={pathname.startsWith('/artist') ? 'account-music' : 'account-music-outline'} 
              size={24} 
              color={pathname.startsWith('/artist') ? theme.colors.primary : theme.colors.text} 
            />
          </Pressable>
        )}
        <Pressable style={styles.iconButton}>
          <MaterialCommunityIcons name="download-outline" size={24} color={theme.colors.text} />
        </Pressable>
        <Pressable style={styles.iconButton}>
          <MaterialCommunityIcons name="bell-outline" size={24} color={theme.colors.text} />
        </Pressable>
        {renderProfileAction()}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  // `position: 'sticky'` is a react-native-web value; native uses static flow.
  // `height`/`paddingTop` are overridden per-render to add the top safe-area
  // inset on native (see `safeAreaStyle`).
  container: webViewStyle({
    height: TOP_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    backgroundColor: 'transparent',
    ...Platform.select({
      web: {
        position: 'sticky',
        top: 0,
        zIndex: 1000,
      },
    }),
  }),
  mobileContainer: {
    gap: 10,
    justifyContent: 'space-between',
  },
  leftSection: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    zIndex: 1,
  },
  logoContainer: {
    zIndex: 2,
    padding: 4,
  },
  mobileLogoContainer: {
    padding: 4,
    flexShrink: 0,
  },
  mobileRightSection: {
    flexShrink: 0,
  },
  centerSection: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    zIndex: 2,
    pointerEvents: 'box-none',
  },
  centerGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  separator: {
    width: 1,
    height: 24,
  },
  activeButton: {
    borderRadius: 20,
  },
  searchShell: {
    position: 'relative',
    minWidth: 400,
    maxWidth: 500,
    height: 48,
    zIndex: 5,
  },
  searchSurface: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    width: '100%',
    borderWidth: 1,
    borderRadius: 24,
    overflow: 'hidden',
    maxHeight: 48,
    ...Platform.select({
      web: webViewStyle({
        transitionProperty: 'max-height, border-radius, box-shadow, border-color',
        transitionDuration: '180ms',
        transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)',
      }),
    }),
  },
  searchSurfaceExpanded: {
    borderRadius: 18,
    maxHeight: 560,
    ...Platform.select({
      web: webViewStyle({
        boxShadow: '0 18px 40px rgba(0, 0, 0, 0.34)',
      }),
    }),
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 24,
    minWidth: 398,
    maxWidth: 498,
  },
  searchInput: {
    fontSize: 14,
    flex: 1,
    padding: 0,
    ...Platform.select({
      web: webTextStyle({ outlineStyle: 'none' }),
    }),
  },
  searchActionSeparator: {
    width: 1,
    height: 22,
  },
  searchOverlay: {
    maxHeight: 500,
  },
  searchOverlayContent: {
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  searchOverlayStateText: {
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 16,
  },
  searchResultSection: {
    paddingVertical: 4,
  },
  searchResultSectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  searchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 7,
    minHeight: 48,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  searchResultArtwork: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
  },
  searchResultImage: {
    width: '100%',
    height: '100%',
  },
  searchResultPlayOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.42)',
  },
  searchResultPlayButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  searchResultText: {
    flex: 1,
    minWidth: 0,
  },
  searchResultTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  searchResultSubtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  viewAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginTop: 4,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  viewAllText: {
    fontSize: 14,
    fontWeight: '700',
  },
  rightSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    zIndex: 1,
  },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  avatarButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    overflow: 'hidden',
  },
  loginButton: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
  },
  loginText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
