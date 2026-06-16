import React from 'react';
import { StyleSheet, View, Text, Image, Pressable, Platform } from 'react-native';
import { webViewStyle } from '@/utils/webStyles';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';

interface GenreCardProps {
  name: string;
  color: string;
  coverArt?: string | null;
  onPress?: () => void;
}

/**
 * Genre Card Component
 * Large colorful card for genre browsing (Spotify-like)
 */
export const GenreCard: React.FC<GenreCardProps> = React.memo(({
  name,
  color,
  coverArt,
  onPress,
}) => {
  const theme = useTheme();
  const [isHovered, setIsHovered] = React.useState(false);

  // Convert hex color to RGB for gradient
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

  const rgb = hexToRgb(color) || { r: 30, g: 50, b: 100 };
  // expo-linear-gradient requires a tuple of at least two colors.
  const gradientColors: readonly [string, string, string] = [
    `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.8)`,
    `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.6)`,
    `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.4)`,
  ];

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setIsHovered(true)}
      onHoverOut={() => setIsHovered(false)}
      style={[
        styles.container,
        isHovered && styles.containerHovered,
        ...Platform.select({
          web: [webViewStyle({ cursor: 'pointer' })],
          default: [],
        }),
      ]}
    >
      <LinearGradient
        colors={gradientColors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.gradient}
      >
        {/* Cover Art (optional) */}
        {coverArt && (
          <View style={styles.coverArtContainer}>
            <Image
              source={{ uri: coverArt }}
              style={styles.coverArt}
              resizeMode="cover"
            />
          </View>
        )}

        {/* Genre Name */}
        <View style={styles.textContainer}>
          <Text style={styles.genreName} numberOfLines={2}>
            {name}
          </Text>
        </View>

        {/* Play Button (appears on hover) */}
        {isHovered && (
          <View style={styles.playButtonContainer}>
            <View style={[styles.playButton, { backgroundColor: theme.colors.primary }]}>
              <Ionicons name="play" size={24} color={theme.colors.primaryForeground} />
            </View>
          </View>
        )}
      </LinearGradient>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  container: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 8,
    overflow: 'hidden',
    ...Platform.select({
      web: {
        boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
      },
      default: {
        elevation: 2,
      },
    }),
  },
  containerHovered: {
    transform: [{ scale: 1.02 }],
    ...Platform.select({
      web: {
        boxShadow: '0 8px 12px rgba(0, 0, 0, 0.2)',
      },
      default: {
        elevation: 4,
      },
    }),
  },
  gradient: {
    flex: 1,
    padding: 16,
    justifyContent: 'space-between',
    position: 'relative',
  },
  coverArtContainer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: '50%',
    opacity: 0.3,
  },
  coverArt: {
    width: '100%',
    height: '100%',
    transform: [{ rotate: '25deg' }, { translateX: 20 }, { translateY: 20 }],
  },
  textContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  genreName: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFFFFF',
    textShadowColor: 'rgba(0, 0, 0, 0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  playButtonContainer: {
    position: 'absolute',
    bottom: 16,
    right: 16,
  },
  playButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        boxShadow: '0 4px 8px rgba(0, 0, 0, 0.3)',
      },
      default: {
        elevation: 3,
      },
    }),
  },
});

