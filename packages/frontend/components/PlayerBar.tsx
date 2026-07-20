import React, { useMemo, useState } from 'react';
import { StyleSheet, View, Text, Pressable, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { usePlayerStore } from '@/stores/playerStore';
import { useQueueStore } from '@/stores/queueStore';
import { useUIStore } from '@/stores/uiStore';
import { Image } from 'expo-image';
import { Slider } from './Slider';
import { DevicePicker } from './DevicePicker';
import { CastButton } from './CastButton';
import { useLibrary, useToggleLikeTrack } from '@/hooks/useLibrary';
import { useNowPlayingMedia } from '@/hooks/useNowPlayingMedia';
import { SpeedPill, SkipButton } from './podcast/PodcastTransportControls';

interface WebPressTarget {
  getBoundingClientRect?: () => { left: number; width: number };
}

interface WebNativePressEvent {
  clientX?: number;
}

const clamp = (value: number, min: number, max: number) => (
  Math.min(max, Math.max(min, value))
);

const getProgressPercent = (currentTime: number, duration: number) => {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  return clamp((currentTime / duration) * 100, 0, 100);
};

/**
 * Desktop Bottom Player Bar Component
 * Full-featured player bar for desktop with all controls
 */
export const PlayerBar: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const toggleNowPlaying = useUIStore(s => s.toggleNowPlaying);
  const [isDevicePickerVisible, setIsDevicePickerVisible] = useState(false);
  const [progressBarWidth, setProgressBarWidth] = useState(0);

  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const isLoading = usePlayerStore(s => s.isLoading);
  const currentTime = usePlayerStore(s => s.currentTime);
  const duration = usePlayerStore(s => s.duration);
  const volume = usePlayerStore(s => s.volume);
  const pause = usePlayerStore(s => s.pause);
  const resume = usePlayerStore(s => s.resume);
  const seek = usePlayerStore(s => s.seek);
  const setVolume = usePlayerStore(s => s.setVolume);
  const playNext = usePlayerStore(s => s.playNext);
  const playPrevious = usePlayerStore(s => s.playPrevious);

  // Unified now-playing view (track or podcast episode).
  const media = useNowPlayingMedia();
  const hasMedia = media !== null;
  const isEpisode = media?.kind === 'episode';

  const queue = useQueueStore(s => s.queue);
  const shuffle = useQueueStore(s => s.shuffle);
  const repeat = useQueueStore(s => s.repeat);
  const toggleShuffle = useQueueStore(s => s.toggleShuffle);
  const cycleRepeat = useQueueStore(s => s.cycleRepeat);

  const { isTrackLiked } = useLibrary();
  const toggleLike = useToggleLikeTrack();
  const isLiked = currentTrack ? isTrackLiked(currentTrack.id) : false;

  const handleToggleLike = () => {
    if (!currentTrack) {
      return;
    }
    toggleLike.mutate({ id: currentTrack.id, next: !isLiked, track: currentTrack });
  };

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

  const seekFromWebPress = (event: { currentTarget: unknown; nativeEvent: unknown }) => {
    const target = event.currentTarget as WebPressTarget;
    const nativeEvent = event.nativeEvent as WebNativePressEvent;
    const rect = target.getBoundingClientRect?.();

    if (rect && nativeEvent.clientX !== undefined && rect.width > 0 && duration > 0) {
      const x = clamp(nativeEvent.clientX - rect.left, 0, rect.width);
      const newPosition = (x / rect.width) * duration;
      handleSeek(newPosition);
    }
  };

  const repeatIcon = repeat === 'one' ? 'repeat-once' : 'repeat';
  const repeatActive = repeat !== 'off';
  const hasNext = !!queue && queue.tracks.length > 1;

  // Always show player bar, even when no track is playing
  const progressPercent = getProgressPercent(currentTime, duration);
  const progressFillWidth = progressBarWidth > 0 ? (progressPercent / 100) * progressBarWidth : 0;

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
        onLayout={(event) => setProgressBarWidth(event.nativeEvent.layout.width)}
        onPress={(e) => {
          if (Platform.OS === 'web') {
            seekFromWebPress(e);
          }
        }}
      >
        <View
          style={[
            styles.progressBar,
            {
              backgroundColor: theme.colors.primary,
              width: progressFillWidth,
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
              if (hasMedia) {
                toggleNowPlaying();
              }
            }}
            style={styles.albumArtPressable}
          >
            {media?.imageUri ? (
              <Image
                source={{ uri: media.imageUri }}
                style={styles.albumArt}
                contentFit="cover"
              />
            ) : (
              <View style={[styles.albumArtPlaceholder, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <MaterialCommunityIcons name={isEpisode ? 'microphone' : 'music'} size={24} color={theme.colors.textSecondary} />
              </View>
            )}
          </Pressable>
          <View style={styles.trackDetails}>
            <Text
              style={[styles.trackTitle, { color: theme.colors.text }]}
              numberOfLines={1}
            >
              {media
                ? media.title
                : (isLoading ? 'Loading...' : 'No track selected')}
            </Text>
            <Text
              style={[styles.trackArtist, { color: theme.colors.textSecondary }]}
              numberOfLines={1}
            >
              {media
                ? media.subtitle
                : (isLoading ? '' : 'Choose a track to play')}
            </Text>
          </View>
          {/* Like is track-only; episodes use the show subscribe action instead. */}
          {!isEpisode && (
            <Pressable
              style={styles.likeButton}
              onPress={handleToggleLike}
              disabled={!currentTrack}
              accessibilityRole="button"
              accessibilityState={{ selected: isLiked }}
              accessibilityLabel={isLiked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
            >
              <MaterialCommunityIcons
                name={isLiked ? 'heart' : 'heart-outline'}
                size={20}
                color={isLiked ? theme.colors.primary : theme.colors.textSecondary}
              />
            </Pressable>
          )}
        </View>

        {/* Center: Playback Controls. Episodes swap shuffle/repeat for skip
            ±15s/±30s and a speed pill; tracks keep shuffle + repeat. */}
        <View style={[styles.playbackControls, { gap: SPACING }]}>
          {isEpisode ? (
            <SkipButton direction="back" seconds={15} size={22} tint={theme.colors.textSecondary} />
          ) : (
            <Pressable
              style={styles.controlButton}
              onPress={toggleShuffle}
              accessibilityRole="button"
              accessibilityState={{ selected: shuffle === 'on' }}
              accessibilityLabel={shuffle === 'on' ? 'Turn shuffle off' : 'Turn shuffle on'}
            >
              <MaterialCommunityIcons
                name="shuffle"
                size={20}
                color={shuffle === 'on' ? theme.colors.primary : theme.colors.textSecondary}
              />
            </Pressable>
          )}
          <Pressable
            style={styles.controlButton}
            onPress={playPrevious}
            disabled={!hasMedia}
            accessibilityRole="button"
            accessibilityLabel={t('common.previous')}
          >
            <MaterialCommunityIcons
              name="skip-previous"
              size={24}
              color={hasMedia ? theme.colors.text : theme.colors.textSecondary}
            />
          </Pressable>
          <Pressable
            style={[
              styles.playButton,
              {
                backgroundColor: hasMedia ? theme.colors.primary : theme.colors.backgroundSecondary,
                opacity: hasMedia ? 1 : 0.5,
              }
            ]}
            onPress={handlePlayPause}
            disabled={isLoading || !hasMedia}
          >
            {isLoading ? (
              <MaterialCommunityIcons name="timer-sand" size={24} color={theme.colors.primaryForeground} />
            ) : (
              <MaterialCommunityIcons
                name={isPlaying ? 'pause' : 'play'}
                size={24}
                color={hasMedia ? theme.colors.primaryForeground : theme.colors.textSecondary}
              />
            )}
          </Pressable>
          <Pressable
            style={styles.controlButton}
            onPress={playNext}
            disabled={!hasMedia}
            accessibilityRole="button"
            accessibilityLabel={hasNext ? 'Next' : 'Autoplay next'}
          >
            <MaterialCommunityIcons
              name="skip-next"
              size={24}
              color={hasMedia ? theme.colors.text : theme.colors.textSecondary}
            />
          </Pressable>
          {isEpisode ? (
            <SkipButton direction="forward" seconds={30} size={22} tint={theme.colors.textSecondary} />
          ) : (
            <Pressable
              style={styles.controlButton}
              onPress={cycleRepeat}
              accessibilityRole="button"
              accessibilityState={{ selected: repeatActive }}
              accessibilityLabel={`Repeat ${repeat}`}
            >
              <MaterialCommunityIcons
                name={repeatIcon}
                size={20}
                color={repeatActive ? theme.colors.primary : theme.colors.textSecondary}
              />
            </Pressable>
          )}
        </View>

        {/* Right: Volume & Queue Controls */}
        <View style={[styles.rightControls, { gap: SPACING }]}>
          {isEpisode && <SpeedPill size="sm" />}
          <Pressable
            style={styles.controlButton}
            onPress={toggleNowPlaying}
            accessibilityRole="button"
            accessibilityLabel={t('player.showQueue')}
          >
            <MaterialCommunityIcons name="playlist-music" size={20} color={theme.colors.textSecondary} />
          </Pressable>
          <Pressable
            style={styles.controlButton}
            onPress={() => setIsDevicePickerVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={t('player.connectDevice')}
          >
            <MaterialCommunityIcons name="devices" size={20} color={theme.colors.textSecondary} />
          </Pressable>
          <CastButton size={20} />
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
    alignSelf: 'stretch',
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
