import React from 'react';
import { StyleSheet, View, Text, Image, Pressable, Platform, GestureResponderEvent } from 'react-native';
import { webViewStyle } from '@/utils/webStyles';
import { useTheme } from '@oxyhq/bloom/theme';
import { Menu } from '@oxyhq/bloom';
import { Ionicons } from '@expo/vector-icons';
import type { TrackImage } from '@syra/shared-types';
import { pickImageUrl } from '@/utils/pickImage';

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
  primaryColor?: string;
  onHoverIn?: () => void;
  onHoverOut?: () => void;
}

function colorWithAlpha(color: string | undefined, alpha: number): string | undefined {
  if (!color) return undefined;
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color.trim());
  if (!match) return undefined;
  const [, r, g, b] = match;
  return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha})`;
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
  primaryColor,
  onHoverIn,
  onHoverOut,
}) => {
  const theme = useTheme();
  const resolvedImageUri = pickImageUrl(images, imageUri, 300);
  const [isHovered, setIsHovered] = React.useState(false);
  const [isPlayButtonHovered, setIsPlayButtonHovered] = React.useState(false);
  const [hideIdleActions, setHideIdleActions] = React.useState(Platform.OS === 'web');
  const menuControl = Menu.useMenuControl();
  const hoverOutTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPlayButtonHoveredRef = React.useRef(false);

  // Auto-detect shape for artist type, or use provided shape
  const cardShape = shape || (type === 'artist' ? 'circle' : 'square');
  const borderRadius = cardShape === 'circle' ? 999 : 8;
  
  // Show play button if card is hovered OR play button itself is hovered
  const showPlayButton = (isHovered || isPlayButtonHovered) && onPlayPress;
  const hasMenu = !!(onAddToQueue || onGoToArtist || onGoToAlbum);
  const isMenuOpen = 'isOpen' in menuControl ? Boolean(menuControl.isOpen) : false;
  const hoverBackground = colorWithAlpha(primaryColor, 0.26) ?? theme.colors.backgroundSecondary;

  React.useEffect(() => () => {
    if (hoverOutTimeoutRef.current) {
      clearTimeout(hoverOutTimeoutRef.current);
    }
  }, []);

  React.useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.matchMedia) {
      setHideIdleActions(false);
      return undefined;
    }

    const mediaQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
    const updateHideIdleActions = () => {
      setHideIdleActions(mediaQuery.matches);
    };

    updateHideIdleActions();
    mediaQuery.addEventListener?.('change', updateHideIdleActions);

    return () => {
      mediaQuery.removeEventListener?.('change', updateHideIdleActions);
    };
  }, []);

  const clearHoverOutTimeout = () => {
    if (hoverOutTimeoutRef.current) {
      clearTimeout(hoverOutTimeoutRef.current);
      hoverOutTimeoutRef.current = null;
    }
  };

  const activateHover = () => {
    clearHoverOutTimeout();
    setIsHovered(true);
    onHoverIn?.();
  };

  const scheduleHoverOut = () => {
    clearHoverOutTimeout();
    hoverOutTimeoutRef.current = setTimeout(() => {
      if (!isPlayButtonHoveredRef.current) {
        setIsHovered(false);
        onHoverOut?.();
      }
      hoverOutTimeoutRef.current = null;
    }, 0);
  };

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

  const renderMenuIcon = (name: React.ComponentProps<typeof Ionicons>['name']) => (
    <Ionicons name={name} size={18} color={theme.colors.textSecondary} />
  );

  const renderActionsMenu = () => {
    if (!hasMenu) return null;

    return (
      <View style={styles.menuContainer}>
        <Menu.Root control={menuControl}>
          <Menu.Trigger label={`More actions for ${title}`}>
            {({ props, state }) => (
              <Pressable
                {...props}
                pointerEvents={
                  hideIdleActions && !isHovered && !isMenuOpen && !state.focused && !state.pressed
                    ? 'none'
                    : 'auto'
                }
                onPress={(event) => {
                  event.stopPropagation?.();
                  props.onPress?.();
                }}
                style={[
                  styles.menuTrigger,
                  hideIdleActions && !isHovered && !isMenuOpen && !state.focused && !state.pressed
                    ? styles.menuTriggerHidden
                    : styles.menuTriggerVisible,
                  {
                    backgroundColor: state.focused || state.pressed
                      ? theme.colors.backgroundTertiary
                      : theme.colors.backgroundSecondary,
                  },
                ]}
              >
                <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.textSecondary} />
              </Pressable>
            )}
          </Menu.Trigger>
          <Menu.Outer style={styles.menuOptions}>
            <Menu.Group>
              {onPress && (
                <Menu.Item
                  label="Open"
                  onPress={(event) => {
                    event.stopPropagation?.();
                    onPress();
                  }}
                >
                  {renderMenuIcon('open-outline')}
                  <Menu.ItemText>Open</Menu.ItemText>
                </Menu.Item>
              )}
              {onAddToQueue && (
                <Menu.Item
                  label="Add to queue"
                  onPress={(event) => {
                    event.stopPropagation?.();
                    onAddToQueue();
                  }}
                >
                  {renderMenuIcon('list-outline')}
                  <Menu.ItemText>Add to queue</Menu.ItemText>
                </Menu.Item>
              )}
              {onGoToAlbum && (
                <Menu.Item
                  label="Go to album"
                  onPress={(event) => {
                    event.stopPropagation?.();
                    onGoToAlbum();
                  }}
                >
                  {renderMenuIcon('disc-outline')}
                  <Menu.ItemText>Go to album</Menu.ItemText>
                </Menu.Item>
              )}
              {onGoToArtist && (
                <Menu.Item
                  label="Go to artist"
                  onPress={(event) => {
                    event.stopPropagation?.();
                    onGoToArtist();
                  }}
                >
                  {renderMenuIcon('person-outline')}
                  <Menu.ItemText>Go to artist</Menu.ItemText>
                </Menu.Item>
              )}
            </Menu.Group>
          </Menu.Outer>
        </Menu.Root>
      </View>
    );
  };
  
  const handleCardHoverOut = () => {
    // Only set hover to false if play button is not hovered
    if (!isPlayButtonHoveredRef.current) {
      scheduleHoverOut();
    }
  };

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={activateHover}
      onHoverOut={() => {
        handleCardHoverOut();
      }}
      onFocus={activateHover}
      onBlur={scheduleHoverOut}
      style={[
        styles.container,
        (isHovered || isMenuOpen) && styles.containerRaised,
        (isHovered || isPlayButtonHovered) && { backgroundColor: hoverBackground },
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
            onHoverIn={() => {
              clearHoverOutTimeout();
              isPlayButtonHoveredRef.current = true;
              setIsPlayButtonHovered(true);
              setIsHovered(true);
              onHoverIn?.();
            }}
            onHoverOut={() => {
              isPlayButtonHoveredRef.current = false;
              setIsPlayButtonHovered(false);
              scheduleHoverOut();
            }}
          >
            <View style={[styles.playButton, { backgroundColor: theme.colors.primary }]}>
              <Ionicons name="play" size={24} color={theme.colors.primaryForeground} />
            </View>
          </Pressable>
        )}
      </View>

      {/* Text Content */}
      <View style={styles.textContainer}>
        <View style={styles.titleRow}>
          <Text
            style={[styles.title, { color: theme.colors.text }]}
            numberOfLines={2}
          >
            {title}
          </Text>
          {renderActionsMenu()}
        </View>
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
    alignSelf: 'stretch',
    padding: 6,
    borderRadius: 8,
    position: 'relative',
    transition: 'background-color 0.2s',
    ...Platform.select({
      web: {
        minWidth: 0,
      },
    }),
  }),
  containerRaised: {
    zIndex: 2000,
  },
  imageContainer: {
    alignSelf: 'stretch',
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
    ...StyleSheet.absoluteFill,
  },
  iconContainer: {
    ...StyleSheet.absoluteFill,
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
    position: 'relative',
    flexShrink: 0,
    width: 28,
    height: 28,
    zIndex: 2001,
  },
  menuTrigger: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  menuTriggerVisible: webViewStyle({
    opacity: 1,
    transform: [{ scale: 1 }],
    ...Platform.select({
      web: {
        transition: 'opacity 0.16s ease, transform 0.16s ease, background-color 0.16s ease',
      },
    }),
  }),
  menuTriggerHidden: webViewStyle({
    opacity: 0,
    transform: [{ scale: 0.96 }],
    ...Platform.select({
      web: {
        transition: 'opacity 0.16s ease, transform 0.16s ease, background-color 0.16s ease',
      },
    }),
  }),
  menuOptions: webViewStyle({
    ...Platform.select({
      web: {
        position: 'absolute',
        top: 32,
        right: 0,
        zIndex: 2002,
      },
    }),
  }),
  textContainer: {
    minHeight: 42,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  title: {
    flex: 1,
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
