import React from 'react';
import { StyleSheet, View, Text, Image, Pressable, Platform, GestureResponderEvent } from 'react-native';
import { webViewStyle } from '@/utils/webStyles';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import type { TrackImage } from '@syra/shared-types';
import { pickImageUrl } from '@/utils/pickImage';
import { Menu, MenuOptions, MenuOption, MenuTrigger } from 'react-native-popup-menu';

interface MediaCardProps {
  title: string;
  subtitle?: string;
  imageUri?: string;
  /** External image set (Audius / CC); used to pick the best size for this card (~300 px). */
  images?: TrackImage[];
  type?: 'playlist' | 'album' | 'artist' | 'podcast' | 'track';
  onPress?: () => void;
  onPlayPress?: () => void;
  onAddToQueue?: () => void;
  onGoToArtist?: () => void;
  onGoToAlbum?: () => void;
  shape?: 'square' | 'circle';
  onHoverIn?: () => void;
  onHoverOut?: () => void;
}

/**
 * Media Card Component
 * Spotify-like card for displaying playlists, albums, artists
 */
const MediaCardComponent: React.FC<MediaCardProps> = ({
  title,
  subtitle,
  imageUri,
  images,
  type = 'playlist',
  onPress,
  onPlayPress,
  onAddToQueue,
  onGoToArtist,
  onGoToAlbum,
  shape,
  onHoverIn,
  onHoverOut,
}) => {
  const theme = useTheme();
  const resolvedImageUri = pickImageUrl(images, imageUri, 300);
  const [isHovered, setIsHovered] = React.useState(false);
  const [isPlayButtonHovered, setIsPlayButtonHovered] = React.useState(false);

  // Auto-detect shape for artist type, or use provided shape
  const cardShape = shape || (type === 'artist' ? 'circle' : 'square');
  const borderRadius = cardShape === 'circle' ? 999 : 8;
  
  // Show play button if card is hovered OR play button itself is hovered
  const showPlayButton = (isHovered || isPlayButtonHovered) && onPlayPress;
  const hasMenu = !!(onAddToQueue || onGoToArtist || onGoToAlbum);

  const getIcon = () => {
    switch (type) {
      case 'artist':
        return 'person';
      case 'podcast':
        return 'mic';
      default:
        return 'musical-notes';
    }
  };

  const handlePlayPress = (e: GestureResponderEvent) => {
    e?.stopPropagation?.();
    onPlayPress?.();
  };
  
  const handleCardHoverOut = () => {
    // Only set hover to false if play button is not hovered
    if (!isPlayButtonHovered) {
      setIsHovered(false);
    }
  };

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => {
        setIsHovered(true);
        onHoverIn?.();
      }}
      onHoverOut={() => {
        handleCardHoverOut();
        onHoverOut?.();
      }}
      style={[
        styles.container,
        (isHovered || isPlayButtonHovered) && { backgroundColor: theme.colors.backgroundSecondary },
        ...Platform.select({
          web: [webViewStyle({ cursor: 'pointer' })],
          default: [],
        }),
      ]}
    >
      {/* Image/Icon */}
      <View style={[
        styles.imageContainer, 
        { 
          backgroundColor: theme.colors.backgroundSecondary,
          borderRadius,
        }
      ]}>
        {resolvedImageUri ? (
          <Image
            source={{ uri: resolvedImageUri }}
            style={[styles.image, { borderRadius }]}
            resizeMode="cover"
          />
        ) : (
          <View style={[styles.iconContainer, { borderRadius }]}>
            <Ionicons name={getIcon()} size={48} color={theme.colors.textSecondary} />
          </View>
        )}
        {/* Play button overlay on hover */}
        {showPlayButton && (
          <Pressable 
            style={styles.playOverlay}
            onPress={handlePlayPress}
            onHoverIn={() => setIsPlayButtonHovered(true)}
            onHoverOut={() => setIsPlayButtonHovered(false)}
          >
            <View style={[styles.playButton, { backgroundColor: theme.colors.primary }]}>
              <Ionicons name="play" size={24} color={theme.colors.primaryForeground} />
            </View>
          </Pressable>
        )}
        {hasMenu && (
          <View style={styles.menuContainer}>
            <Menu>
              <MenuTrigger
                customStyles={{
                  TriggerTouchableComponent: Pressable,
                  triggerWrapper: [
                    styles.menuTrigger,
                    { backgroundColor: 'rgba(0, 0, 0, 0.55)' },
                  ],
                }}
              >
                <Ionicons name="ellipsis-horizontal" size={18} color="#FFFFFF" />
              </MenuTrigger>
              <MenuOptions
                customStyles={{
                  optionsContainer: [
                    styles.menuOptions,
                    { backgroundColor: theme.colors.backgroundTertiary },
                  ],
                }}
              >
                {onPress && (
                  <MenuOption onSelect={onPress} customStyles={{ optionWrapper: styles.menuOption }}>
                    <Ionicons name="open-outline" size={18} color={theme.colors.text} />
                    <Text style={[styles.menuOptionText, { color: theme.colors.text }]}>Open</Text>
                  </MenuOption>
                )}
                {onAddToQueue && (
                  <MenuOption onSelect={onAddToQueue} customStyles={{ optionWrapper: styles.menuOption }}>
                    <Ionicons name="list-outline" size={18} color={theme.colors.text} />
                    <Text style={[styles.menuOptionText, { color: theme.colors.text }]}>Add to queue</Text>
                  </MenuOption>
                )}
                {onGoToAlbum && (
                  <MenuOption onSelect={onGoToAlbum} customStyles={{ optionWrapper: styles.menuOption }}>
                    <Ionicons name="disc-outline" size={18} color={theme.colors.text} />
                    <Text style={[styles.menuOptionText, { color: theme.colors.text }]}>Go to album</Text>
                  </MenuOption>
                )}
                {onGoToArtist && (
                  <MenuOption onSelect={onGoToArtist} customStyles={{ optionWrapper: styles.menuOption }}>
                    <Ionicons name="person-outline" size={18} color={theme.colors.text} />
                    <Text style={[styles.menuOptionText, { color: theme.colors.text }]}>Go to artist</Text>
                  </MenuOption>
                )}
              </MenuOptions>
            </Menu>
          </View>
        )}
      </View>

      {/* Text Content */}
      <View style={styles.textContainer}>
        <Text 
          style={[styles.title, { color: theme.colors.text }]} 
          numberOfLines={2}
        >
          {title}
        </Text>
        {subtitle && (
          <Text 
            style={[styles.subtitle, { color: theme.colors.textSecondary }]} 
            numberOfLines={2}
          >
            {subtitle}
          </Text>
        )}
      </View>
    </Pressable>
  );
};

export const MediaCard = React.memo(MediaCardComponent);

const styles = StyleSheet.create({
  // `transition` is a react-native-web value; it is a no-op on native.
  container: webViewStyle({
    padding: 6,
    borderRadius: 8,
    transition: 'background-color 0.2s',
    ...Platform.select({
      web: {
        minWidth: 0,
      },
    }),
  }),
  imageContainer: {
    width: '100%',
    aspectRatio: 1,
    overflow: 'hidden',
    marginBottom: 6,
    position: 'relative',
    ...Platform.select({
      web: {
        boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
      },
    }),
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
  playOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  playButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateY: 8 }], // Slight offset like Spotify
  },
  menuContainer: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 4,
  },
  menuTrigger: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  menuOptions: {
    borderRadius: 8,
    paddingVertical: 4,
    minWidth: 180,
  },
  menuOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  menuOptionText: {
    fontSize: 14,
    fontWeight: '500',
  },
  textContainer: {
    minHeight: 42,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
    lineHeight: 18,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 16,
  },
});
