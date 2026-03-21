import React from 'react';
import { StyleSheet, View, Text, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { Track } from '@syra/shared-types';
import { formatDuration } from '@/utils/musicUtils';

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
export const TrackRow: React.FC<TrackRowProps> = React.memo(({
  track,
  index,
  isCurrentTrack,
  isTrackPlaying,
  onPress,
  onPlayPress,
  showNumber = true,
}) => {
  const theme = useTheme();

  return (
    <Pressable
      style={[
        styles.trackRow,
        isCurrentTrack && { backgroundColor: theme.colors.backgroundSecondary + '40' },
        ...Platform.select({
          web: [{ cursor: 'pointer' as any }],
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
              <View style={styles.explicitBadge}>
                <Text style={styles.explicitText}>E</Text>
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
      </View>
    </Pressable>
  );
});

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
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  explicitText: {
    color: '#fff',
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

