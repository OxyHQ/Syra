import React, { useMemo } from 'react';
import { StyleSheet, View, Text, Pressable, Platform } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlayerStore } from '@/stores/playerStore';
import { Image } from 'expo-image';

/**
 * Mobile Bottom Player Bar Component
 * Floating, fully rounded player bar for mobile devices
 */
export const MobilePlayerBar: React.FC = () => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const {
    currentTrack,
    isPlaying,
    isLoading,
    currentTime,
    duration,
    pause,
    resume,
    seek,
  } = usePlayerStore();

  const handlePlayPause = async () => {
    if (isPlaying) {
      await pause();
    } else {
      await resume();
    }
  };

  const handleSeek = async (newPosition: number) => {
    await seek(newPosition);
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Uniform spacing constant - used for both padding and gaps
  const SPACING = 8;

  // Mobile: Floating, rounded, positioned above bottom nav
  const containerStyle = useMemo(() => {
    // Calculate bottom position: bottom nav (60px + 8px padding) + no gap
    const bottomOffset = 68 + (Platform.OS === 'web' ? 0 : insets.bottom);
    
    return {
      ...styles.container,
      backgroundColor: theme.colors.primary,
      borderRadius: 16,
      overflow: 'hidden' as const,
      ...Platform.select({
        web: {
          position: 'fixed' as any,
          bottom: bottomOffset,
          left: SPACING,
          right: SPACING,
          zIndex: 999,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
        },
        default: {
          position: 'absolute' as const,
          bottom: bottomOffset,
          left: SPACING,
          right: SPACING,
          zIndex: 999,
          elevation: 8,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.15,
          shadowRadius: 12,
        },
      }),
    };
  }, [insets.bottom, theme.colors.primary, SPACING]);

  return (
    <View style={containerStyle}>
      {/* Main Player Content */}
      <View style={[styles.content, { paddingHorizontal: SPACING, paddingVertical: SPACING, gap: SPACING }]}>
        {/* Left: Track Info */}
        <View style={[styles.trackInfo, { gap: SPACING }]}>
          <Pressable style={styles.albumArtPressable}>
            {currentTrack?.coverArt ? (
              <Image
                source={{ uri: currentTrack.coverArt }}
                style={styles.albumArt}
                contentFit="cover"
              />
            ) : (
              <View style={[styles.albumArtPlaceholder, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <MaterialCommunityIcons name="music" size={24} color={theme.colors.textSecondary} />
              </View>
            )}
          </Pressable>
          <View style={styles.trackDetails}>
            <Text
              style={[styles.trackTitle, { color: theme.colors.primaryForeground }]}
              numberOfLines={1}
            >
              {currentTrack
                ? (currentTrack.title || currentTrack.artistName || 'Untitled track')
                : (isLoading ? 'Loading...' : 'No track selected')}
            </Text>
            <Text
              style={[styles.trackArtist, { color: theme.colors.primaryForeground, opacity: 0.7 }]}
              numberOfLines={1}
            >
              {currentTrack?.artistName || (isLoading ? '' : 'Choose a track to play')}
            </Text>
          </View>
        </View>

        {/* Center: Playback Controls */}
        <View style={[styles.playbackControls, { gap: SPACING }]}>
          <Pressable style={styles.controlButton}>
            <MaterialCommunityIcons name="heart-outline" size={24} color={theme.colors.primaryForeground} />
          </Pressable>
          <Pressable
            style={[
              styles.playButton,
              {
                backgroundColor: theme.colors.primaryForeground,
                opacity: currentTrack ? 1 : 0.5,
              }
            ]}
            onPress={handlePlayPause}
            disabled={isLoading || !currentTrack}
          >
            {isLoading ? (
              <MaterialCommunityIcons name="timer-sand" size={24} color={theme.colors.primary} />
            ) : (
              <MaterialCommunityIcons
                name={isPlaying ? 'pause' : 'play'}
                size={24}
                color={currentTrack ? theme.colors.primary : theme.colors.textSecondary}
              />
            )}
          </Pressable>
          <Pressable style={styles.controlButton}>
            <MaterialCommunityIcons name="skip-next" size={24} color={theme.colors.primaryForeground} />
          </Pressable>
        </View>
      </View>

      {/* Progress Bar - At bottom */}
      <Pressable
        style={[styles.progressBarContainer, { backgroundColor: 'rgba(255, 255, 255, 0.3)' }]}
        onPress={(e) => {
          if (Platform.OS === 'web') {
            const rect = (e.target as any)?.getBoundingClientRect();
            if (rect) {
              const clientX = (e.nativeEvent as any).clientX;
              if (clientX !== undefined) {
                const x = clientX - rect.left;
                const newPosition = (x / rect.width) * duration;
                handleSeek(newPosition);
              }
            }
          }
        }}
      >
        <View
          style={[
            styles.progressBar,
            {
              backgroundColor: theme.colors.primaryForeground,
              width: `${progressPercent}%`,
            }
          ]}
        />
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    // Width is controlled by left/right positioning, not 100%
  },
  progressBarContainer: {
    height: 4,
    width: '100%',
    borderBottomLeftRadius: 16, // Match container borderRadius
    borderBottomRightRadius: 16, // Match container borderRadius
    overflow: 'hidden',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  progressBar: {
    height: '100%',
    ...Platform.select({
      web: {
        transition: 'width 0.1s linear',
      },
    }),
  },
  content: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  trackInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
  },
  albumArtPressable: {
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  albumArt: {
    width: 40,
    height: 40,
    borderRadius: 4,
    overflow: 'hidden',
  },
  albumArtPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackDetails: {
    flex: 1,
    minWidth: 0,
  },
  trackTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  trackArtist: {
    fontSize: 13,
  },
  playbackControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 0,
  },
});

