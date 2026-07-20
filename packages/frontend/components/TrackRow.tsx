import React from 'react';
import { StyleSheet, View, Text, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { Track } from '@syra/shared-types';
import { formatDuration } from '@/utils/musicUtils';
import { useLibrary, useToggleLikeTrack } from '@/hooks/useLibrary';
import { webViewStyle } from '@/utils/webStyles';

interface TrackRowProps {
  track: Track;
  index: number;
  isCurrentTrack: boolean;
  isTrackPlaying: boolean;
  onPress: () => void;
  onPlayPress: () => void;
  showNumber?: boolean;
  /**
   * Opens this row's overflow menu (add to playlist / remove from playlist).
   * The button is omitted entirely when no handler is given, so screens that
   * have no per-track actions render exactly as before.
   */
  onMorePress?: () => void;
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
  onMorePress,
}) => {
  const theme = useTheme();
  const { isTrackLiked } = useLibrary();
  const toggleLike = useToggleLikeTrack();
  const isLiked = isTrackLiked(track.id);

  const handleToggleLike = () => {
    toggleLike.mutate({ id: track.id, next: !isLiked, track });
  };

  return (
    <Pressable
      style={[
        styles.trackRow,
        isCurrentTrack && { backgroundColor: theme.colors.backgroundSecondary + '40' },
        ...Platform.select({
          web: [webViewStyle({ cursor: 'pointer' })],
          default: [],
        }),
      ]}
      onPress={onPress}
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
            color={theme.colors.text}
          />
        </Pressable>
        <Text style={[styles.trackDuration, { color: theme.colors.textSecondary }]}>
          {formatDuration(track.duration)}
        </Text>
        {onMorePress && (
          <Pressable
            onPress={(e) => {
              e?.stopPropagation?.();
              onMorePress();
            }}
            style={styles.moreButton}
            accessibilityRole="button"
            accessibilityLabel={`More options for ${track.title}`}
          >
            <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.textSecondary} />
          </Pressable>
        )}
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
  moreButton: {
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
