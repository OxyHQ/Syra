import React, { useEffect, useState } from 'react';
import { StyleSheet, View, Text, Pressable, Platform, ViewStyle } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useOxy } from '@oxyhq/services';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Avatar from './Avatar';
import { Logo } from './Logo';
import { useMediaQuery } from 'react-responsive';
import { artistService } from '@/services/artistService';
import { Artist } from '@syra/shared-types';
/**
 * Top Navigation Bar Component
 * Spotify-like top bar with logo, navigation, search, and user controls
 */
export const TopBar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const theme = useTheme();
  const { user, isAuthenticated, oxyServices, showBottomSheet } = useOxy();
  const isMobile = useMediaQuery({ maxWidth: 767 });
  const [artistProfile, setArtistProfile] = useState<Artist | null>(null);
  
  const avatarUri = user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') : undefined;

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
    <View style={styles.container}>
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
            style={[styles.iconButton, pathname === '/' && styles.activeButton]}
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
              style={[styles.iconButton, pathname === '/search' && styles.activeButton]}
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
            style={[styles.iconButton, pathname.startsWith('/artist') && styles.activeButton]}
            onPress={handleDashboard}
            title={artistProfile ? 'Artist Dashboard' : 'Register as Artist'}
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
            onPress={() => showBottomSheet?.('SignIn')}
          >
            <Text style={[styles.loginText, { color: '#FFFFFF' }]}>Log in</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    backgroundColor: 'transparent',
    ...Platform.select({
      web: {
        position: 'sticky' as any,
        top: 0,
        zIndex: 1000,
      },
    }),
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
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
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

