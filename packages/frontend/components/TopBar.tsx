import React, { useEffect, useState } from 'react';
import { StyleSheet, View, Text, Pressable, Platform, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { webViewStyle } from '@/utils/webStyles';
import { useRouter, usePathname } from 'expo-router';
import { useTheme } from '@oxyhq/bloom/theme';
import { useOxy } from '@oxyhq/services';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Avatar from './Avatar';
import { Logo } from './Logo';
import { useMediaQuery } from 'react-responsive';
import { artistService } from '@/services/artistService';
import { Artist } from '@syra/shared-types';
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
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { user, isAuthenticated, oxyServices, showBottomSheet } = useOxy();
  const isMobile = useMediaQuery({ maxWidth: 767 });
  const [artistProfile, setArtistProfile] = useState<Artist | null>(null);

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

  // Check if user has an artist profile
  useEffect(() => {
    if (isAuthenticated && user) {
      artistService.getMyArtistProfile()
        .then((artist) => {
          setArtistProfile(artist);
        })
        .catch((error) => {
          // Silently handle - getMyArtistProfile returns null for 404, so this shouldn't happen
          // But if it does, just set to null
          setArtistProfile(null);
        });
    } else {
      setArtistProfile(null);
    }
  }, [isAuthenticated, user]);

  const handleHome = () => {
    router.push('/');
  };

  const handleSearch = () => {
    router.push('/search');
  };

  const handleLibrary = () => {
    router.push('/library');
  };

  const handleDashboard = () => {
    if (artistProfile) {
      router.push('/artist/dashboard');
    } else {
      // User doesn't have an artist profile, redirect to register
      router.push('/artist/register');
    }
  };

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
          
          {isMobile ? (
            <Pressable 
              onPress={handleSearch}
              style={[styles.iconButton, pathname === '/search' && activeButtonStyle]}
            >
              <MaterialCommunityIcons 
                name={pathname === '/search' ? 'magnify' : 'magnify'} 
                size={24} 
                color={pathname === '/search' ? theme.colors.primary : theme.colors.text} 
              />
            </Pressable>
          ) : (
            <Pressable 
              onPress={handleSearch}
              style={[styles.searchContainer, { backgroundColor: theme.colors.backgroundSecondary }]}
            >
              <MaterialCommunityIcons name="magnify" size={20} color={theme.colors.textSecondary} />
              <Text style={[styles.searchPlaceholder, { color: theme.colors.textSecondary }]}>
                What do you want to play?
              </Text>
            </Pressable>
          )}
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
        {isAuthenticated && user ? (
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
        )}
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
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 24,
    minWidth: 400,
    maxWidth: 500,
  },
  searchPlaceholder: {
    fontSize: 14,
    flex: 1,
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

