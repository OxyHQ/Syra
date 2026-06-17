import React from 'react';
import { StyleSheet, View, Text, Image, Pressable, Platform } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import type { TrackImage } from '@syra/shared-types';
import { pickImageUrl } from '@/utils/pickImage';
import { webViewStyle } from '@/utils/webStyles';

interface CompactMusicCardProps {
  title: string;
  imageUri?: string;
  /** External image set (Audius / CC); used to pick the best size for this card (~150 px). */
  images?: TrackImage[];
  type?: 'playlist' | 'album' | 'artist' | 'mix';
  shape?: 'square' | 'circle';
  isPlaying?: boolean;
  onPress?: () => void;
}

/**
 * Compact Music Card Component
 * More compact card for 8-item grid - supports both circular and square shapes
 */
export const CompactMusicCard: React.FC<CompactMusicCardProps> = ({
  title,
  imageUri,
  images,
  type = 'playlist',
  shape = 'square',
  isPlaying = false,
  onPress
}) => {
  const resolvedImageUri = pickImageUrl(images, imageUri, 150);
  const theme = useTheme();

  const getIcon = () => {
    switch (type) {
      case 'artist':
        return 'person';
      case 'mix':
        return 'layers';
      default:
        return 'musical-notes';
    }
  };

  const borderRadius = shape === 'circle' ? 999 : 8;

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.container,
        ...Platform.select({
          web: [webViewStyle({ cursor: 'pointer' })],
          default: [],
        }),
      ]}
    >
      {/* Image/Icon */}
      <View 
        style={[
          styles.imageContainer, 
          { 
            backgroundColor: theme.colors.backgroundSecondary,
            borderRadius,
          }
        ]}
      >
        {resolvedImageUri ? (
          <Image
            source={{ uri: resolvedImageUri }}
            style={[styles.image, { borderRadius }]}
            resizeMode="cover"
          />
        ) : (
          <View style={[styles.iconContainer, { borderRadius }]}>
            <Ionicons name={getIcon()} size={32} color={theme.colors.textSecondary} />
          </View>
        )}
      </View>

      {/* Text Content */}
      <Text 
        style={[styles.title, { color: theme.colors.text }]} 
        numberOfLines={1}
      >
        {title}
      </Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  imageContainer: {
    width: '100%',
    aspectRatio: 1,
    overflow: 'hidden',
    marginBottom: 8,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  iconContainer: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 18,
  },
});
