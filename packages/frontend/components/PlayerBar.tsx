import React, { useMemo, useState } from 'react';
import { StyleSheet, View, Text, Pressable, Platform } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { usePlayerStore } from '@/stores/playerStore';
import { useUIStore } from '@/stores/uiStore';
import { Image } from 'expo-image';
import { Slider } from './Slider';
import { DevicePicker } from './DevicePicker';
import { pickImageUrl } from '@/utils/pickImage';

/**
 * Desktop Bottom Player Bar Component
 * Full-featured player bar for desktop with all controls
 */
export const PlayerBar: React.FC = () => {
  const theme = useTheme();
  const { toggleNowPlaying } = useUIStore();
  const [isDevicePickerVisible, setIsDevicePickerVisible] = useState(false);

  const {
    currentTrack,
    isPlaying,
    isLoading,
    currentTime,
    duration,
    volume,
    pause,
    resume,
    seek,
    setVolume,
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

  // Always show player bar, even when no track is playing
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Uniform spacing constant - used for both padding and gaps
  const SPACING = 12;

  // Desktop: Normal flow container style
  const containerStyle = useMemo(() => ({
    ...styles.container,
    backgroundColor: theme.colors.background,
  }), [theme.colors.background]);

  return (
    <View style={containerStyle}>
      {/* Progress Bar */}
      <Pressable
        style={[styles.progressBarContainer, { backgroundColor: theme.colors.border }]}
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
              backgroundColor: theme.colors.primary,
              width: `${progressPercent}%`,
            }
          ]}
        />
      </Pressable>

      {/* Main Player Content */}
      <View style={[styles.content, { paddingHorizontal: SPACING, paddingVertical: SPACING, gap: SPACING }]}>
        {/* Left: Track Info */}
        <View style={[styles.trackInfo, { gap: SPACING }]}>
          <Pressable
            onPress={() => {
              if (currentTrack) {
                toggleNowPlaying();
              }
            }}
            style={styles.albumArtPressable}
          >
            {(currentTrack?.coverArt || currentTrack?.images?.length) ? (
              <Image
                source={{ uri: pickImageUrl(currentTrack.images, currentTrack.coverArt, 150) }}
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
              style={[styles.trackTitle, { color: theme.colors.text }]}
              numberOfLines={1}
            >
              {currentTrack
                ? (currentTrack.title || currentTrack.artistName || 'Untitled track')
                : (isLoading ? 'Loading...' : 'No track selected')}
            </Text>
            <Text
              style={[styles.trackArtist, { color: theme.colors.textSecondary }]}
              numberOfLines={1}
            >
              {currentTrack?.artistName || (isLoading ? '' : 'Choose a track to play')}
            </Text>
          </View>
          <Pressable style={styles.likeButton}>
            <MaterialCommunityIcons name="heart-outline" size={20} color={theme.colors.textSecondary} />
          </Pressable>
        </View>

        {/* Center: Playback Controls */}
        <View style={[styles.playbackControls, { gap: SPACING }]}>
          <Pressable style={styles.controlButton}>
            <MaterialCommunityIcons name="shuffle" size={20} color={theme.colors.textSecondary} />
          </Pressable>
          <Pressable style={styles.controlButton}>
            <MaterialCommunityIcons name="skip-previous" size={24} color={theme.colors.text} />
          </Pressable>
          <Pressable
            style={[
              styles.playButton,
              {
                backgroundColor: currentTrack ? theme.colors.primary : theme.colors.backgroundSecondary,
                opacity: currentTrack ? 1 : 0.5,
              }
            ]}
            onPress={handlePlayPause}
            disabled={isLoading || !currentTrack}
          >
            {isLoading ? (
              <MaterialCommunityIcons name="timer-sand" size={24} color={theme.colors.primaryForeground} />
            ) : (
              <MaterialCommunityIcons
                name={isPlaying ? 'pause' : 'play'}
                size={24}
                color={currentTrack ? theme.colors.primaryForeground : theme.colors.textSecondary}
              />
            )}
          </Pressable>
          <Pressable style={styles.controlButton}>
            <MaterialCommunityIcons name="skip-next" size={24} color={theme.colors.text} />
          </Pressable>
          <Pressable style={styles.controlButton}>
            <MaterialCommunityIcons name="repeat" size={20} color={theme.colors.textSecondary} />
          </Pressable>
        </View>

        {/* Right: Volume & Queue Controls */}
        <View style={[styles.rightControls, { gap: SPACING }]}>
          <Pressable style={styles.controlButton}>
            <MaterialCommunityIcons name="playlist-music" size={20} color={theme.colors.textSecondary} />
          </Pressable>
          <Pressable
            style={styles.controlButton}
            onPress={() => setIsDevicePickerVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="Connect to a device"
          >
            <MaterialCommunityIcons name="devices" size={20} color={theme.colors.textSecondary} />
          </Pressable>
          <View style={[styles.volumeContainer, { gap: SPACING }]}>
            <MaterialCommunityIcons
              name={volume === 0 ? 'volume-off' : volume < 0.5 ? 'volume-low' : 'volume-high'}
              size={20}
              color={theme.colors.textSecondary}
            />
            <View style={styles.volumeSliderWrapper}>
              <Slider
                value={volume}
                onValueChange={setVolume}
                minimumValue={0}
                maximumValue={1}
                step={0.01}
                disabled={false}
                showValue={false}
              />
            </View>
          </View>
          <Pressable style={styles.controlButton}>
            <MaterialCommunityIcons name="fullscreen" size={20} color={theme.colors.textSecondary} />
          </Pressable>
        </View>
      </View>

      <DevicePicker
        visible={isDevicePickerVisible}
        onClose={() => setIsDevicePickerVisible(false)}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    // Positioning is now handled dynamically in the component based on isMobile
  },
  progressBarContainer: {
    height: 4,
    width: '100%',
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
    flex: 0.3,
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
    width: 56,
    height: 56,
    borderRadius: 4,
    overflow: 'hidden',
  },
  albumArtPlaceholder: {
    width: 56,
    height: 56,
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
  likeButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playbackControls: {
    flex: 0.4,
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
  rightControls: {
    flex: 0.3,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  volumeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    maxWidth: 120,
  },
  volumeSliderWrapper: {
    flex: 1,
    height: 40,
    justifyContent: 'center',
  },
});

