import React from 'react';
import { StyleSheet, View, Text, Image, Pressable, Platform, GestureResponderEvent } from 'react-native';
import { webViewStyle } from '@/utils/webStyles';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from '@oxyhq/bloom/dropdown-menu';
import { useInteractionStates } from '@oxyhq/bloom/hooks';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { CatalogImageSizes, TrackImage } from '@syra/shared-types';
import { pickCatalogImageUrl } from '@/utils/pickImage';
import { Z_INDEX } from '@/lib/constants';

interface MediaCardProps {
  title: string;
  subtitle?: string;
  imageUri?: string;
  /**
   * A fully-resolved image URL to render directly, bypassing the catalog image
   * pipeline. Required for podcast/episode artwork, whose external (rss) URLs
   * are dropped by `pickCatalogImageUrl` (it only resolves Oxy/catalog ids).
   */
  resolvedImageUri?: string;
  /** External image set (CC); used to pick the best size for this card (~300 px). */
  images?: TrackImage[];
  /** Internal catalog image variants; used before the large coverArt fallback. */
  imageSizes?: CatalogImageSizes;
  type?: 'playlist' | 'album' | 'artist' | 'podcast' | 'track';
  onPress?: () => void;
  onPlayPress?: () => void;
  onAddToQueue?: () => void;
  onGoToArtist?: () => void;
  onGoToAlbum?: () => void;
  shape?: 'square' | 'circle';
  /** Pre-computed cover accent (DTO field); drives the card's own subtle hover-lift background. */
  primaryColor?: string;
  /** Supporting cover colour (DTO field); forwarded to app-wide ambient theming. */
  secondaryColor?: string;
  /**
   * Called on hover-in/focus with the card's server-extracted cover colours, so
   * the surrounding browse screen can drive Bloom's app-wide ambient theming
   * (`useAmbientTheme`) from this card. The card already receives `primaryColor` /
   * `secondaryColor` from its DTO; it simply forwards them here.
   */
  onHoverIn?: (colors: { primaryColor?: string; secondaryColor?: string }) => void;
  onHoverOut?: () => void;
}

function colorWithAlpha(color: string | undefined, alpha: number): string | undefined {
  if (!color) return undefined;
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color.trim());
  if (!match) return undefined;
  const [, r, g, b] = match;
  return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha})`;
}

function shouldHideIdleActionsByDefault(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.matchMedia) {
    return false;
  }
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/**
 * Media Card Component
 * Spotify-like card for displaying playlists, albums, artists
 */
const MediaCardComponent: React.FC<MediaCardProps> = ({
  title,
  subtitle,
  imageUri,
  resolvedImageUri: resolvedImageUriProp,
  images,
  imageSizes,
  type = 'playlist',
  onPress,
  onPlayPress,
  onAddToQueue,
  onGoToArtist,
  onGoToAlbum,
  shape,
  primaryColor,
  secondaryColor,
  onHoverIn,
  onHoverOut,
}) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const resolvedImageUri = resolvedImageUriProp ?? pickCatalogImageUrl(images, imageUri, 'card', imageSizes);
  const [isHovered, setIsHovered] = React.useState(false);
  const [hideIdleActions, setHideIdleActions] = React.useState(shouldHideIdleActionsByDefault);
  const [isMenuOpen, setIsMenuOpen] = React.useState(false);
  const {
    focused: triggerFocused,
    pressed: triggerPressed,
    focusHandlers: triggerFocusHandlers,
    pressHandlers: triggerPressHandlers,
  } = useInteractionStates();
  const isHoveredRef = React.useRef(false);
  const isPointerInsideCardRef = React.useRef(false);
  const suppressNextPressRef = React.useRef(false);

  // Auto-detect shape for artist type, or use provided shape
  const cardShape = shape || (type === 'artist' ? 'circle' : 'square');
  const borderRadius = cardShape === 'circle' ? 999 : 8;
  
  const showPlayButton = isHovered && onPlayPress;
  const hasMenu = !!(onAddToQueue || onGoToArtist || onGoToAlbum);
  const usesHoverActions = hideIdleActions;
  /**
   * `backgroundTertiary`, not `backgroundSecondary`, when the cover has no accent.
   *
   * The accent is a DEEP-import product: the shallow directory upsert gives a show
   * a title and an image but no `primaryColor`, so a freshly-seeded catalogue has
   * cards whose hover falls back. `backgroundSecondary` is the same role the card's
   * own art frame uses, so hovering merged the two into one flat block and read as
   * 'hover stopped working' — which is exactly how this was reported after the
   * Postgres cutover reseeded every show. `backgroundTertiary` is a distinct
   * surface, so the fallback is visibly a hover rather than an absence.
   *
   * Note `colorWithAlpha` parses HEX only. That is right for `primaryColor`, which
   * is server-extracted hex — but it silently returns undefined for a Bloom token,
   * which resolves to `rgb(...)`. Never feed it one.
   */
  const hoverBackground = colorWithAlpha(primaryColor, 0.26) ?? theme.colors.backgroundTertiary;

  React.useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.matchMedia) {
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

  const setCardHoverState = React.useCallback((nextHovered: boolean) => {
    if (isHoveredRef.current === nextHovered) {
      return;
    }

    isHoveredRef.current = nextHovered;
    setIsHovered(nextHovered);

    if (nextHovered) {
      onHoverIn?.({ primaryColor, secondaryColor });
    } else {
      onHoverOut?.();
    }
  }, [onHoverIn, onHoverOut, primaryColor, secondaryColor]);

  const activateHover = React.useCallback(() => {
    isPointerInsideCardRef.current = true;
    setCardHoverState(true);
  }, [setCardHoverState]);

  const deactivateHover = React.useCallback(() => {
    isPointerInsideCardRef.current = false;
    if (!isMenuOpen) {
      setCardHoverState(false);
    }
  }, [isMenuOpen, setCardHoverState]);

  React.useEffect(() => {
    if (!isMenuOpen && !isPointerInsideCardRef.current) {
      setCardHoverState(false);
    }
  }, [isMenuOpen, setCardHoverState]);

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

  const handleCardPress = React.useCallback(() => {
    if (suppressNextPressRef.current) {
      suppressNextPressRef.current = false;
      return;
    }

    onPress?.();
  }, [onPress]);

  const handleLongPress = React.useCallback((event?: GestureResponderEvent) => {
    if (!hasMenu || usesHoverActions) {
      return;
    }

    event?.stopPropagation?.();
    suppressNextPressRef.current = true;
    isPointerInsideCardRef.current = true;
    setCardHoverState(true);
    setIsMenuOpen(true);
  }, [hasMenu, setCardHoverState, usesHoverActions]);

  const renderMenuIcon = (name: React.ComponentProps<typeof Ionicons>['name']) => (
    <Ionicons name={name} size={18} color={theme.colors.textSecondary} />
  );

  const renderActionsMenu = () => {
    if (!hasMenu) return null;

    // The trigger fades in on hover, and must stay visible while it is focused
    // or held so a keyboard user can still see what they are on. Bloom's
    // anchored trigger has no render prop any more, so the two flags come from
    // the hook the old `MenuTrigger` render prop was reading internally.
    const hideMenuTrigger =
      !usesHoverActions ||
      (!isHovered && !isMenuOpen && !triggerFocused && !triggerPressed);

    return (
      <View style={styles.menuContainer}>
        <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
          <DropdownMenuTrigger asChild label={`More actions for ${title}`}>
            <Pressable
              {...triggerFocusHandlers}
              {...triggerPressHandlers}
              pointerEvents={hideMenuTrigger ? 'none' : 'auto'}
              // Composed with, not replacing, the open handler the trigger
              // merges in: without this the same press also reaches the card
              // underneath and navigates away from the menu being opened.
              onPress={(event) => {
                event.stopPropagation?.();
              }}
              style={[
                styles.menuTrigger,
                hideMenuTrigger
                  ? styles.menuTriggerHidden
                  : styles.menuTriggerVisible,
                {
                  backgroundColor: triggerFocused || triggerPressed
                    ? theme.colors.backgroundTertiary
                    : theme.colors.backgroundSecondary,
                },
              ]}
            >
              <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.textSecondary} />
            </Pressable>
          </DropdownMenuTrigger>
          {/*
            `align="end"` reproduces the old panel's `right: 0`; the 4px gap the
            old `top: 32` left below a 28px trigger is Bloom's default
            `sideOffset`. Nothing here positions the panel by hand any more — it
            is portalled and placed by Bloom's own resolver, which also flips it
            above the card near the bottom of the viewport, where the absolutely
            positioned panel used to run off screen.
          */}
          <DropdownMenuContent align="end" label={`More actions for ${title}`}>
            <DropdownMenuGroup>
              {onPress && (
                <DropdownMenuItem
                  leading={renderMenuIcon('open-outline')}
                  onPress={onPress}
                >
                  {t('common.open')}
                </DropdownMenuItem>
              )}
              {onAddToQueue && (
                <DropdownMenuItem
                  leading={renderMenuIcon('list-outline')}
                  onPress={onAddToQueue}
                >
                  {t('common.addToQueue')}
                </DropdownMenuItem>
              )}
              {onGoToAlbum && (
                <DropdownMenuItem
                  leading={renderMenuIcon('disc-outline')}
                  onPress={onGoToAlbum}
                >
                  {t('common.goToAlbum')}
                </DropdownMenuItem>
              )}
              {onGoToArtist && (
                <DropdownMenuItem
                  leading={renderMenuIcon('person-outline')}
                  onPress={onGoToArtist}
                >
                  {t('common.goToArtist')}
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    );
  };
  
  const hoverHandlers = Platform.OS === 'web'
    ? ({
      onMouseEnter: activateHover,
      onMouseLeave: deactivateHover,
    } as Record<string, unknown>)
    : {
      onHoverIn: activateHover,
      onHoverOut: deactivateHover,
    };

  return (
    <Pressable
      {...hoverHandlers}
      onPress={handleCardPress}
      onLongPress={hasMenu && !usesHoverActions ? handleLongPress : undefined}
      delayLongPress={350}
      onFocus={activateHover}
      onBlur={deactivateHover}
      style={[
        styles.container,
        (isHovered || isMenuOpen) && styles.containerRaised,
        isHovered && { backgroundColor: hoverBackground },
        ...Platform.select({
          web: [webViewStyle({ cursor: 'pointer' })],
          default: [],
        }),
      ]}
    >
      {/* Image/Icon */}
      <View className="bg-surface" style={[styles.imageContainer, { borderRadius }]}>
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
        {/* Play control on hover — a discrete button rather than a full-cover
            overlay, so the rest of the artwork still opens the entity. A fill
            made the whole cover a play target and left only the title strip
            navigating, the inverse of what a listener expects. */}
        {showPlayButton && (
          <Pressable
            className="bg-primary" style={styles.playButton}
            onPress={handlePlayPress}
            accessibilityRole="button"
            accessibilityLabel={t('common.playTitle', { title })}
          >
            <Ionicons name="play" size={22} color={theme.colors.primaryForeground} />
          </Pressable>
        )}
      </View>

      {/* Text Content */}
      <View style={styles.textContainer}>
        <View style={styles.titleRow}>
          <Text
            className="text-foreground" style={styles.title}
            numberOfLines={2}
          >
            {title}
          </Text>
          {renderActionsMenu()}
        </View>
        {subtitle && (
          <Text 
            className="text-muted-foreground" style={styles.subtitle} 
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
    zIndex: Z_INDEX.CARD_ACTIVE,
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
  playButton: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
        boxShadow: '0 8px 16px rgba(0, 0, 0, 0.3)',
      },
    }),
  },
  menuContainer: {
    position: 'relative',
    flexShrink: 0,
    width: 28,
    height: 28,
    zIndex: Z_INDEX.CARD_ACTIONS,
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
