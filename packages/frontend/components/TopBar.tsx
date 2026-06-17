import React, { useState } from 'react';
import { StyleSheet, View, Text, Pressable, Platform, ViewStyle, TextInput, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { webViewStyle } from '@/utils/webStyles';
import { useRouter, usePathname, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@oxyhq/bloom/theme';
import { useOxy } from '@oxyhq/services';
import { useQuery } from '@tanstack/react-query';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Avatar from './Avatar';
import { Logo } from './Logo';
import { useMediaQuery } from 'react-responsive';
import { artistService } from '@/services/artistService';
import { searchService } from '@/services/searchService';
import { searchRefetchInterval } from '@/utils/searchUtils';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { pickImageUrl } from '@/utils/pickImage';
import { Album, Artist, Playlist, SearchCategory, SearchUser, Track } from '@syra/shared-types';
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
  const { user, isAuthenticated, oxyServices, showBottomSheet } = useOxy();
  const isMobile = useMediaQuery({ maxWidth: 767 });
  const [searchQuery, setSearchQuery] = useState(() => (pathname === '/search' && typeof q === 'string' ? q : ''));
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // Whether the signed-in user has an artist profile (decides dashboard vs. register).
  // Only runs while authenticated; when signed out the query is disabled and resolves
  // to no profile.
  const { data: artistProfile } = useQuery({
    queryKey: ['artist', 'me', 'topbar'],
    queryFn: () => artistService.getMyArtistProfile(),
    enabled: isAuthenticated && !!user,
  });

  // Clear the status bar / dynamic island on native by padding the bar's
  // content down by the top inset and growing the bar by the same amount. On
  // web `insets.top` is 0, so the bar keeps its base 64px height there.
  const safeAreaStyle: ViewStyle = {
    paddingTop: insets.top,
    height: TOP_BAR_HEIGHT + insets.top,
  };

  const avatarUri = user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') : undefined;

  // Subtle raised pill behind the active nav icon, derived from the theme.
  const activeButtonStyle: ViewStyle = { ...styles.activeButton, backgroundColor: theme.colors.backgroundTertiary };
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
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    setIsSearchOpen(false);
  };

  const handleBrowse = () => {
    setSearchQuery('');
    setIsSearchOpen(false);
    router.push('/search');
  };


  const handleDashboard = () => {
    if (artistProfile) {
      router.push('/artist/dashboard');
    } else {
      // User doesn't have an artist profile, redirect to register
      router.push('/artist/register');
    }
  };

  const navigateFromSearch = (href: string) => {
    setIsSearchOpen(false);
    router.push(href as any);
  };

  const renderArtwork = (imageUri: string | undefined, icon: keyof typeof MaterialCommunityIcons.glyphMap, rounded = false) => (
    <View
      style={[
        styles.searchResultArtwork,
        {
          backgroundColor: theme.colors.backgroundTertiary,
          borderRadius: rounded ? 18 : 6,
        },
      ]}
    >
      {imageUri ? (
        <Image source={{ uri: imageUri }} style={[styles.searchResultImage, { borderRadius: rounded ? 18 : 6 }]} />
      ) : (
        <MaterialCommunityIcons name={icon} size={18} color={theme.colors.textSecondary} />
      )}
    </View>
  );

  const renderSearchResultRow = ({
    key,
    title,
    subtitle,
    imageUri,
    icon,
    rounded,
    onPress,
  }: {
    key: string;
    title: string;
    subtitle: string;
    imageUri?: string;
    icon: keyof typeof MaterialCommunityIcons.glyphMap;
    rounded?: boolean;
    onPress: () => void;
  }) => (
    <Pressable
      key={key}
      onPress={onPress}
      style={({ pressed }) => [
        styles.searchResultRow,
        pressed && { backgroundColor: theme.colors.backgroundTertiary },
      ]}
    >
      {renderArtwork(imageUri, icon, rounded)}
      <View style={styles.searchResultText}>
        <Text style={[styles.searchResultTitle, { color: theme.colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.searchResultSubtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );

  const renderSearchSection = (
    title: string,
    rows: React.ReactNode[],
  ) => {
    if (rows.length === 0) return null;

    return (
      <View style={styles.searchResultSection}>
        <Text style={[styles.searchResultSectionTitle, { color: theme.colors.textSecondary }]}>{title}</Text>
        {rows}
      </View>
    );
  };

  const renderSearchOverlay = () => {
    const results = headerSearchResults?.results;
    const totalResults = headerSearchResults?.counts.total ?? 0;
    const trackRows = (results?.tracks ?? []).slice(0, 4).map((track: Track) => (
      renderSearchResultRow({
        key: `track-${track.id}`,
        title: track.title,
        subtitle: track.artistName,
        imageUri: pickImageUrl(track.images, track.coverArt, 64),
        icon: 'music-note-outline',
        onPress: () => navigateFromSearch(track.albumId ? `/album/${track.albumId}` : `/search?q=${encodeURIComponent(searchQuery.trim())}`),
      })
    ));
    const albumRows = (results?.albums ?? []).slice(0, 3).map((album: Album) => (
      renderSearchResultRow({
        key: `album-${album.id}`,
        title: album.title,
        subtitle: album.artistName,
        imageUri: album.coverArt,
        icon: 'album',
        onPress: () => navigateFromSearch(`/album/${album.id}`),
      })
    ));
    const artistRows = (results?.artists ?? []).slice(0, 3).map((artist: Artist) => (
      renderSearchResultRow({
        key: `artist-${artist.id}`,
        title: artist.name,
        subtitle: 'Artist',
        imageUri: pickImageUrl(artist.images, artist.image, 64),
        icon: 'account-music-outline',
        rounded: true,
        onPress: () => navigateFromSearch(`/artist/${artist.id}`),
      })
    ));
    const playlistRows = (results?.playlists ?? []).slice(0, 2).map((playlist: Playlist) => (
      renderSearchResultRow({
        key: `playlist-${playlist.id}`,
        title: playlist.name,
        subtitle: `Playlist - ${playlist.trackCount || 0} songs`,
        imageUri: playlist.coverArt,
        icon: 'playlist-music-outline',
        onPress: () => navigateFromSearch(`/playlist/${playlist.id}`),
      })
    ));
    const userRows = (results?.users ?? []).slice(0, 2).map((searchUser: SearchUser) => (
      renderSearchResultRow({
        key: `user-${searchUser.id}`,
        title: searchUser.displayName,
        subtitle: `@${searchUser.username}`,
        imageUri: searchUser.avatar ? oxyServices.getFileDownloadUrl(searchUser.avatar, 'thumb') : undefined,
        icon: 'account-outline',
        rounded: true,
        onPress: () => navigateFromSearch(`/u/${searchUser.username}`),
      })
    ));

    return (
      <View style={styles.searchOverlay}>
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
            {renderSearchSection('Tracks', trackRows)}
            {renderSearchSection('Albums', albumRows)}
            {renderSearchSection('Artists', artistRows)}
            {renderSearchSection('Playlists', playlistRows)}
            {renderSearchSection('Users', userRows)}
            <Pressable
              onPress={handleSearchSubmit}
              style={({ pressed }) => [
                styles.viewAllButton,
                pressed && { backgroundColor: theme.colors.backgroundTertiary },
              ]}
            >
              <Text style={[styles.viewAllText, { color: theme.colors.primary }]}>View all results</Text>
              <MaterialCommunityIcons name="arrow-right" size={18} color={theme.colors.primary} />
            </Pressable>
          </>
        )}
      </View>
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
          source={{ uri: avatarUri }}
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
            <Logo />
          </View>
        </Pressable>
        <View style={styles.mobileCenterActions}>
          <Pressable
            onPress={handleSearch}
            style={[styles.iconButton, pathname === '/search' && activeButtonStyle]}
          >
            <MaterialCommunityIcons
              name="magnify"
              size={24}
              color={pathname === '/search' ? theme.colors.primary : theme.colors.text}
            />
          </Pressable>
        </View>
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
            <Logo />
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
              color={pathname === '/' ? theme.colors.primary : theme.colors.text} 
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
    justifyContent: 'flex-start',
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
  mobileCenterActions: {
    flex: 1,
    alignItems: 'center',
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
      web: {
        transitionProperty: 'max-height, border-radius, box-shadow, border-color',
        transitionDuration: '180ms',
        transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)',
      } as any,
    }),
  },
  searchSurfaceExpanded: {
    borderRadius: 18,
    maxHeight: 560,
    ...Platform.select({
      web: {
        boxShadow: '0 18px 40px rgba(0, 0, 0, 0.34)',
      } as any,
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
    outlineStyle: 'none' as any,
  },
  searchActionSeparator: {
    width: 1,
    height: 22,
  },
  searchOverlay: {
    paddingHorizontal: 8,
    paddingBottom: 8,
    maxHeight: 560,
    overflow: 'hidden',
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
  },
  searchResultImage: {
    width: '100%',
    height: '100%',
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
