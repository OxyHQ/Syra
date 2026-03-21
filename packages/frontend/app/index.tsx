import React, { useState, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, ScrollView, Text, Platform, Pressable, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@/hooks/useTheme';
import { useOxy } from '@oxyhq/services';
import { useRouter } from 'expo-router';
import SEO from '@/components/SEO';
import { MediaCard } from '@/components/MediaCard';
import { musicService } from '@/services/musicService';
import { Track, Album, Artist, Playlist } from '@syra/shared-types';
import { usePlayerStore } from '@/stores/playerStore';
import { Ionicons } from '@expo/vector-icons';

/**
 * Quick access item type - can be album, artist, or playlist
 */
type QuickAccessItem =
  | { type: 'album'; data: Album; shape: 'square' }
  | { type: 'artist'; data: Artist; shape: 'circle' }
  | { type: 'playlist'; data: Playlist; shape: 'square' };

/**
 * Syra Home Screen
 * Spotify-like home screen with recently played, made for you, etc.
 */
const HomeScreen: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const [activeFilter, setActiveFilter] = useState<'All' | 'Music' | 'Podcasts' | 'Audiobooks'>('All');
  const { playTrack } = usePlayerStore();

  // State for tracks
  const [tracks, setTracks] = useState<Track[]>([]);
  const [tracksLoading, setTracksLoading] = useState(true);

  // State for quick access (albums, artists, playlists)
  const [albums, setAlbums] = useState<Album[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [userPlaylists, setUserPlaylists] = useState<Playlist[]>([]);
  const [quickAccessLoading, setQuickAccessLoading] = useState(true);

  // State for recently played and made for you
  const [recentlyPlayed, setRecentlyPlayed] = useState<Playlist[]>([]);
  const [madeForYou, setMadeForYou] = useState<Playlist[]>([]);
  const [recentlyPlayedAlbums, setRecentlyPlayedAlbums] = useState<Album[]>([]);
  const [madeForYouAlbums, setMadeForYouAlbums] = useState<Album[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(true);

  // State for hover gradient color with smooth transitions
  const [hoveredItemColor, setHoveredItemColor] = useState<string | null>(null);
  const [displayGradientColor, setDisplayGradientColor] = useState<string | null>(null);
  const currentDisplayColorRef = useRef<string | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Smooth color transition when hoveredItemColor changes
  useEffect(() => {
    // Cancel any ongoing animation
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    let isCancelled = false;
    const transitionDuration = 300; // milliseconds
    const startTime = performance.now();
    const startColor = currentDisplayColorRef.current;
    const targetColor = hoveredItemColor;

    // If no change, skip animation
    if (targetColor === startColor) {
      return;
    }

    // Helper to interpolate between two RGB colors
    const interpolateRgb = (
      start: { r: number; g: number; b: number },
      end: { r: number; g: number; b: number },
      progress: number
    ): { r: number; g: number; b: number } => {
      return {
        r: Math.round(start.r + (end.r - start.r) * progress),
        g: Math.round(start.g + (end.g - start.g) * progress),
        b: Math.round(start.b + (end.b - start.b) * progress),
      };
    };

    // Convert RGB to hex string
    const rgbToHex = (rgb: { r: number; g: number; b: number }): string => {
      return `#${rgb.r.toString(16).padStart(2, '0')}${rgb.g.toString(16).padStart(2, '0')}${rgb.b.toString(16).padStart(2, '0')}`;
    };

    // Easing function for smooth animation (ease-in-out)
    const easeInOut = (t: number): number => {
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    };

    // Get RGB values for start and target colors
    const getStartRgb = (): { r: number; g: number; b: number } => {
      if (startColor) {
        const rgb = hexToRgb(startColor);
        if (rgb) return rgb;
      }
      // Default to theme primary color
      const defaultRgb = hexToRgb(theme.colors.primary);
      return defaultRgb || { r: 128, g: 128, b: 128 };
    };

    const getTargetRgb = (): { r: number; g: number; b: number } | null => {
      if (targetColor) {
        return hexToRgb(targetColor);
      }
      return null;
    };

    const startRgb = getStartRgb();
    const targetRgb = getTargetRgb();

    const animate = () => {
      if (isCancelled) return;

      const elapsed = performance.now() - startTime;
      const rawProgress = Math.min(elapsed / transitionDuration, 1);
      const easedProgress = easeInOut(rawProgress);

      if (targetRgb) {
        // Transitioning to a specific color
        const currentRgb = interpolateRgb(startRgb, targetRgb, easedProgress);
        const currentHex = rgbToHex(currentRgb);
        setDisplayGradientColor(currentHex);
        currentDisplayColorRef.current = currentHex;
      } else {
        // Transitioning back to default - interpolate to default theme color
        const defaultRgb = hexToRgb(theme.colors.primary) || { r: 128, g: 128, b: 128 };
        const currentRgb = interpolateRgb(startRgb, defaultRgb, easedProgress);
        const currentHex = rgbToHex(currentRgb);
        setDisplayGradientColor(currentHex);
        currentDisplayColorRef.current = currentHex;
      }

      if (rawProgress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        // Animation complete - set final state
        if (targetColor) {
          setDisplayGradientColor(targetColor);
          currentDisplayColorRef.current = targetColor;
        } else {
          // Transitioned to null - set to null to use default gradient
          setDisplayGradientColor(null);
          currentDisplayColorRef.current = null;
        }
        animationFrameRef.current = null;
      }
    };

    // Start animation
    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      isCancelled = true;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [hoveredItemColor, theme.colors.primary]);

  // Fetch tracks on mount
  useEffect(() => {
    const fetchTracks = async () => {
      try {
        setTracksLoading(true);
        const response = await musicService.getTracks({ limit: 20 });
        setTracks(response.tracks);
      } catch (error) {
        console.error('[HomeScreen] Error fetching tracks:', error);
      } finally {
        setTracksLoading(false);
      }
    };

    fetchTracks();
  }, []);

  // Fetch quick access data (albums, artists, playlists)
  useEffect(() => {
    const fetchQuickAccess = async () => {
      try {
        setQuickAccessLoading(true);

        const [albumsResponse, artistsResponse] = await Promise.all([
          musicService.getAlbums({ limit: 4 }),
          musicService.getArtists({ limit: 4 }),
        ]);

        setAlbums(albumsResponse.albums);
        setArtists(artistsResponse.artists);

        // Only fetch user playlists if authenticated
        if (isAuthenticated) {
          try {
            const playlistsResponse = await musicService.getUserPlaylists();
            setUserPlaylists(playlistsResponse.playlists);
          } catch (error) {
            console.error('[HomeScreen] Error fetching user playlists:', error);
          }
        }
      } catch (error) {
        console.error('[HomeScreen] Error fetching quick access data:', error);
      } finally {
        setQuickAccessLoading(false);
      }
    };

    fetchQuickAccess();
  }, [isAuthenticated]);

  // Fetch recently played and made for you sections
  useEffect(() => {
    const fetchSections = async () => {
      try {
        setSectionsLoading(true);

        if (isAuthenticated) {
          // Fetch user playlists for authenticated users
          const playlistsResponse = await musicService.getUserPlaylists();
          const allPlaylists = playlistsResponse.playlists;

          // Split playlists: first 4 for recently played, rest for made for you
          setRecentlyPlayed(allPlaylists.slice(0, 4));
          setMadeForYou(allPlaylists.slice(4, 8));
          setRecentlyPlayedAlbums([]);
          setMadeForYouAlbums([]);
        } else {
          // For unauthenticated users, use popular albums
          const albumsResponse = await musicService.getAlbums({ limit: 8 });
          // Split albums: first 4 for recently played, rest for made for you
          setRecentlyPlayed([]);
          setMadeForYou([]);
          setRecentlyPlayedAlbums(albumsResponse.albums.slice(0, 4));
          setMadeForYouAlbums(albumsResponse.albums.slice(4, 8));
        }
      } catch (error) {
        console.error('[HomeScreen] Error fetching sections:', error);
      } finally {
        setSectionsLoading(false);
      }
    };

    fetchSections();
  }, [isAuthenticated]);

  // Get greeting based on time
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  };

  // Helper function to convert hex color to RGB
  const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
      : null;
  };

  // Convert hex to rgba string for LinearGradient
  const hexToRgba = (hex: string, alpha: number = 0.2): string => {
    const rgb = hexToRgb(hex);
    if (!rgb) return `rgba(128, 128, 128, ${alpha})`; // Fallback gray
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  };

  // Handle hover in - set the color
  const handleHoverIn = (color: string | null | undefined) => {
    if (color) {
      setHoveredItemColor(color);
    }
  };

  // Handle hover out - reset to default
  const handleHoverOut = () => {
    setHoveredItemColor(null);
  };

  // Get the current gradient top color with smooth transitions
  const getGradientTopColor = (): string => {
    if (displayGradientColor) {
      // Use hovered color with opacity for top 20%
      return hexToRgba(displayGradientColor, 0.2);
    }
    // Default to theme primary with opacity
    return hexToRgba(theme.colors.primary, 0.2);
  };

  // Compute quick access items from fetched data (mix of albums, artists, playlists)
  const quickAccess = useMemo<QuickAccessItem[]>(() => {
    const items: QuickAccessItem[] = [];

    // Add albums (up to 4)
    albums.slice(0, 4).forEach(album => {
      items.push({ type: 'album', data: album, shape: 'square' });
    });

    // Add artists (up to 2)
    artists.slice(0, 2).forEach(artist => {
      items.push({ type: 'artist', data: artist, shape: 'circle' });
    });

    // Add playlists (up to 2, or fill remaining slots)
    const remainingSlots = 8 - items.length;
    userPlaylists.slice(0, remainingSlots).forEach(playlist => {
      items.push({ type: 'playlist', data: playlist, shape: 'square' });
    });

    return items.slice(0, 8);
  }, [albums, artists, userPlaylists]);

  return (
    <>
      <SEO
        title="Syra - Music Streaming"
        description="Discover and play your favorite music"
      />
      <LinearGradient
        colors={[getGradientTopColor(), theme.colors.background]}
        locations={[0, 0.2]}
        style={styles.gradientContainer}
      >
        <ScrollView
          style={[styles.scrollView, { backgroundColor: 'transparent' }]}
          contentContainerStyle={[
            styles.contentContainer,
            { paddingBottom: 100 } // Space for bottom player bar
          ]}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.colors.text }]}>
              {getGreeting()}
            </Text>
          </View>

          {/* Filter Chips */}
          <View style={styles.filtersContainer}>
            {(['All', 'Music', 'Podcasts', 'Audiobooks'] as const).map((filter) => (
              <Pressable
                key={filter}
                onPress={() => setActiveFilter(filter)}
                style={[
                  styles.filterButton,
                  {
                    backgroundColor: activeFilter === filter
                      ? theme.colors.primary + '20'
                      : theme.colors.backgroundSecondary,
                    borderColor: activeFilter === filter
                      ? theme.colors.primary
                      : 'transparent',
                  }
                ]}
              >
                <Text
                  style={[
                    styles.filterText,
                    {
                      color: activeFilter === filter
                        ? theme.colors.primary
                        : theme.colors.text
                    }
                  ]}
                >
                  {filter}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* 8-Item Compact Grid (2 columns) - Just image/icon and text */}
          {quickAccessLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
          ) : quickAccess.length > 0 && (
            <View style={styles.compactGrid}>
              {quickAccess.map((item) => {
                const title = item.type === 'album'
                  ? item.data.title
                  : item.type === 'artist'
                    ? item.data.name
                    : item.data.name;
                const id = item.data.id;

                const primaryColor = (item.data as any).primaryColor;

                return (
                  <Pressable
                    key={`${item.type}-${id}`}
                    style={[styles.compactGridItem, { backgroundColor: theme.colors.backgroundSecondary }]}
                    onPress={() => {
                      // Navigate based on type
                      if (item.type === 'album') {
                        router.push(`/album/${id}` as any);
                      } else if (item.type === 'playlist') {
                        router.push(`/playlist/${id}` as any);
                      } else if (item.type === 'artist') {
                        // Artist navigation handled gracefully (no page yet)
                        // Could navigate to artist page in future: router.push(`/artist/${id}`);
                      }
                    }}
                    onHoverIn={() => handleHoverIn(primaryColor)}
                    onHoverOut={handleHoverOut}
                  >
                    <View
                      style={[
                        styles.compactImageContainer,
                        {
                          backgroundColor: theme.colors.background,
                          borderRadius: item.shape === 'circle' ? 999 : 12,
                        }
                      ]}
                    >
                      <Ionicons
                        name={item.type === 'artist' ? 'person' : 'musical-notes'}
                        size={24}
                        color={theme.colors.textSecondary}
                      />
                    </View>
                    <Text
                      style={[styles.compactTitle, { color: theme.colors.text }]}
                      numberOfLines={1}
                    >
                      {title}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Recently Played Section */}
          {sectionsLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
          ) : (recentlyPlayed.length > 0 || recentlyPlayedAlbums.length > 0) && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Recently played
              </Text>
              <View style={styles.grid}>
                {recentlyPlayed.map((playlist) => (
                  <View
                    key={playlist.id}
                    style={styles.gridItem}
                  >
                    <MediaCard
                      title={playlist.name}
                      subtitle={playlist.description || 'Playlist'}
                      type="playlist"
                      onPress={() => {
                        router.push(`/playlist/${playlist.id}` as any);
                      }}
                      onPlayPress={() => {
                        router.push(`/playlist/${playlist.id}` as any);
                      }}
                      onHoverIn={() => handleHoverIn((playlist as any).primaryColor)}
                      onHoverOut={handleHoverOut}
                    />
                  </View>
                ))}
                {recentlyPlayedAlbums.map((album) => (
                  <View
                    key={album.id}
                    style={styles.gridItem}
                  >
                    <MediaCard
                      title={album.title}
                      subtitle={album.artistName}
                      type="album"
                      imageUri={album.coverArt}
                      onPress={() => {
                        router.push(`/album/${album.id}` as any);
                      }}
                      onPlayPress={async () => {
                        // Fetch album tracks and play first track
                        try {
                          const tracksData = await musicService.getAlbumTracks(album.id);
                          if (tracksData.tracks.length > 0) {
                            playTrack(tracksData.tracks[0]);
                          }
                        } catch (error) {
                          console.error('[HomeScreen] Error playing album:', error);
                        }
                      }}
                      onHoverIn={() => handleHoverIn((album as any).primaryColor)}
                      onHoverOut={handleHoverOut}
                    />
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Made for You Section */}
          {sectionsLoading ? null : (madeForYou.length > 0 || madeForYouAlbums.length > 0) && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Made for you
              </Text>
              <View style={styles.grid}>
                {madeForYou.map((playlist) => (
                  <View
                    key={playlist.id}
                    style={styles.gridItem}
                  >
                    <MediaCard
                      title={playlist.name}
                      subtitle={playlist.description || 'Playlist'}
                      type="playlist"
                      onPress={() => {
                        router.push(`/playlist/${playlist.id}` as any);
                      }}
                      onPlayPress={() => {
                        router.push(`/playlist/${playlist.id}` as any);
                      }}
                      onHoverIn={() => handleHoverIn((playlist as any).primaryColor)}
                      onHoverOut={handleHoverOut}
                    />
                  </View>
                ))}
                {madeForYouAlbums.map((album) => (
                  <View
                    key={album.id}
                    style={styles.gridItem}
                  >
                    <MediaCard
                      title={album.title}
                      subtitle={album.artistName}
                      type="album"
                      imageUri={album.coverArt}
                      onPress={() => {
                        router.push(`/album/${album.id}` as any);
                      }}
                      onPlayPress={async () => {
                        // Fetch album tracks and play first track
                        try {
                          const tracksData = await musicService.getAlbumTracks(album.id);
                          if (tracksData.tracks.length > 0) {
                            playTrack(tracksData.tracks[0]);
                          }
                        } catch (error) {
                          console.error('[HomeScreen] Error playing album:', error);
                        }
                      }}
                      onHoverIn={() => handleHoverIn((album as any).primaryColor)}
                      onHoverOut={handleHoverOut}
                    />
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Tracks Section */}
          {tracksLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
            </View>
          ) : tracks.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Tracks
              </Text>
              <View style={styles.grid}>
                {tracks.map((track) => (
                  <View
                    key={track.id}
                    style={styles.gridItem}
                  >
                    <MediaCard
                      title={track.title}
                      subtitle={track.artistName}
                      type="track"
                      onPress={() => {
                        // Navigate to album page if albumId exists
                        if (track.albumId) {
                          router.push(`/album/${track.albumId}`);
                        }
                      }}
                      onPlayPress={() => playTrack(track)}
                    />
                  </View>
                ))}
              </View>
            </View>
          )}
        </ScrollView>
      </LinearGradient>
    </>
  );
};

const styles = StyleSheet.create({
  gradientContainer: {
    flex: 1,
    ...Platform.select({
      web: {
        transition: 'all 0.3s ease',
      },
    }),
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    ...Platform.select({
      web: {
        maxWidth: '100%',
      },
    }),
  },
  header: {
    marginBottom: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
  },
  filtersContainer: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 20,
    alignItems: 'center',
  },
  filterButton: {
    paddingHorizontal: 13,
    paddingVertical: 4,
    borderRadius: 13,
    borderWidth: 1,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
  filterText: {
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 14,
  },
  compactGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 24,
    gap: 8,
  },
  compactGridItem: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: 12,
    marginBottom: 4,
    alignItems: 'center',
    ...Platform.select({
      web: {
        width: 'calc(50% - 4px)',
      },
      default: {
        width: '48%',
      },
    }),
  },
  compactImageContainer: {
    width: 40,
    height: 40,
    marginRight: 6,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  compactTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 16,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
  },
  gridItem: {
    paddingHorizontal: 4,
    paddingBottom: 6,
    ...Platform.select({
      web: {
        width: '20%', // 5 columns on desktop
        minWidth: 180,
        maxWidth: 220,
      },
      default: {
        width: '50%', // 2 columns on mobile
      },
    }),
  },
  loadingContainer: {
    padding: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default HomeScreen;
