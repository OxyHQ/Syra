import React from 'react';
import { StyleSheet, View, Text, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { Track } from '@syra/shared-types';
import { formatDuration } from '@/utils/musicUtils';
import { useLibrary, useToggleLikeTrack } from '@/hooks/useLibrary';
import { colorWithAlpha } from '@/utils/color';

interface TrackRowProps {
  track: Track;
  index: number;
  isCurrentTrack: boolean;
  isTrackPlaying: boolean;
  onPress: () => void;
  onPlayPress: () => void;
  showNumber?: boolean;
}

/**
 * Reusable Track Row Component
 * Used in search results, charts, album pages, etc.
 */
const TrackRowComponent: React.FC<TrackRowProps> = ({
  track,
  index,
  isCurrentTrack,
  isTrackPlaying,
  onPress,
  onPlayPress,
  showNumber = true,
}) => {
  const theme = useTheme();
  const { isTrackLiked } = useLibrary();
  const toggleLike = useToggleLikeTrack();
  const isLiked = isTrackLiked(track.id);
  const [isHovered, setIsHovered] = React.useState(false);
  const activeBackground =
    colorWithAlpha(theme.colors.primary, theme.isDark ? 0.18 : 0.1)
    ?? theme.colors.backgroundSecondary;
  const hoverBackground =
    colorWithAlpha(theme.colors.primary, theme.isDark ? 0.24 : 0.14)
    ?? theme.colors.backgroundSecondary;

  const handleToggleLike = () => {
    toggleLike.mutate({ id: track.id, next: !isLiked });
  };

  return (
    <Pressable
      style={[
        styles.trackRow,
        isCurrentTrack && { backgroundColor: activeBackground },
        isHovered && { backgroundColor: hoverBackground },
        ...Platform.select({
          web: [{ cursor: 'pointer' as any }],
          default: [],
        }),
      ]}
      onPress={onPress}
      onHoverIn={() => setIsHovered(true)}
      onHoverOut={() => setIsHovered(false)}
    >
      <View style={styles.trackRowLeft}>
        {showNumber && (
          <View style={styles.trackNumberContainer}>
            {isTrackPlaying ? (
              <Ionicons name="volume-high" size={16} color={theme.colors.primary} />
            ) : (
              <Text
                style={[
                  styles.trackNumber,
                  { color: isCurrentTrack ? theme.colors.primary : theme.colors.textSecondary }
                ]}
              >
                {index + 1}
              </Text>
            )}
          </View>
        )}
        <View style={styles.trackInfo}>
          <Text
            style={[
              styles.trackTitle,
              { color: isCurrentTrack ? theme.colors.primary : theme.colors.text }
            ]}
            numberOfLines={1}
          >
            {track.title}
          </Text>
          <View style={styles.trackArtistRow}>
            {track.isExplicit && (
              <View style={[styles.explicitBadge, { backgroundColor: theme.colors.backgroundTertiary }]}>
                <Text style={[styles.explicitText, { color: theme.colors.textSecondary }]}>E</Text>
              </View>
            )}
            <Text
              style={[styles.trackArtist, { color: theme.colors.textSecondary }]}
              numberOfLines={1}
            >
              {track.artistName}
            </Text>
          </View>
        </View>
      </View>
      <View style={styles.trackRowRight}>
        <Pressable
          onPress={(e) => {
            e?.stopPropagation?.();
            handleToggleLike();
          }}
          style={styles.likeButton}
          accessibilityRole="button"
          accessibilityState={{ selected: isLiked }}
          accessibilityLabel={isLiked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
        >
          <Ionicons
            name={isLiked ? 'heart' : 'heart-outline'}
            size={18}
            color={isLiked ? theme.colors.primary : theme.colors.textSecondary}
          />
        </Pressable>
        <Pressable
          onPress={(e) => {
            e?.stopPropagation?.();
            onPlayPress();
          }}
          style={styles.playButton}
        >
          <Ionicons
            name={isTrackPlaying ? 'pause' : 'play'}
            size={20}
            color={(isHovered || isCurrentTrack) ? theme.colors.primary : theme.colors.text}
          />
        </Pressable>
        <Text style={[styles.trackDuration, { color: theme.colors.textSecondary }]}>
          {formatDuration(track.duration)}
        </Text>
      </View>
    </Pressable>
  );
};

export const TrackRow = React.memo(TrackRowComponent);

const styles = StyleSheet.create({
  trackRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 4,
    minHeight: 48,
  },
  trackRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    flex: 1,
    minWidth: 0,
  },
  trackNumberContainer: {
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackNumber: {
    fontSize: 14,
    textAlign: 'center',
  },
  trackInfo: {
    flex: 1,
    minWidth: 0,
  },
  trackTitle: {
    fontSize: 15,
    fontWeight: '400',
    marginBottom: 4,
  },
  trackArtistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  explicitBadge: {
    width: 18,
    height: 18,
    borderRadius: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  explicitText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  trackArtist: {
    fontSize: 14,
  },
  trackRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  likeButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  playButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackDuration: {
    fontSize: 14,
    width: 50,
    textAlign: 'right',
  },
});
