import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { Ionicons, MaterialCommunityIcons, Octicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Search } from '@oxyhq/bloom/search';
import { useOxy } from '@oxyhq/services';
import { useUploads } from '@/hooks/useUploads';
import { Image } from 'expo-image';
import { Playlist, Album, Artist } from '@syra/shared-types';
import { pickCatalogImageUrl } from '@/utils/pickImage';
import { EmptyState } from '@/components/common/EmptyState';
import { cn } from '@/lib/utils';
import type { LibrarySortOrder } from '@/stores/uiStore';

/** Exported so the sidebar's filter state cannot drift from the chips it renders. */
export type LibraryFilter = 'All' | 'Playlists' | 'Artists' | 'Albums' | 'Uploads' | 'Podcasts';
type LibraryEntryKind = 'playlist' | 'liked' | 'artist' | 'album' | 'uploads';

interface LibraryEntry {
  id: string;
  kind: LibraryEntryKind;
  title: string;
  subtitle: string;
  href: Href;
  imageUrl?: string;
  imageShape: 'square' | 'circle';
}

interface LibrarySidebarExpandedProps {
  displayMode: 'list' | 'grid';
  searchQuery: string;
  activeFilter: LibraryFilter;
  isFullscreen: boolean;
  onFullscreen: () => void;
  onCollapse: () => void;
  onSearchChange: (query: string) => void;
  onFilterChange: (filter: LibraryFilter) => void;
  sortOrder: LibrarySortOrder;
  onSortOrderChange: (order: LibrarySortOrder) => void;
  playlists: Playlist[];
  savedAlbums: Album[];
  followedArtists: Artist[];
  likedTracksCount: number;
  loading: boolean;
  error: string | null;
  /** Re-arms the auth gate and refetches the library queries behind these props. */
  onRetry: () => Promise<void>;
}

const FILTERS: LibraryFilter[] = ['All', 'Playlists', 'Artists', 'Albums', 'Uploads', 'Podcasts'];

function filterAllowsEntry(filter: LibraryFilter, kind: LibraryEntryKind): boolean {
  if (filter === 'All') {
    return true;
  }
  if (filter === 'Playlists') {
    return kind === 'playlist' || kind === 'liked';
  }
  if (filter === 'Artists') {
    return kind === 'artist';
  }
  if (filter === 'Albums') {
    return kind === 'album';
  }
  if (filter === 'Uploads') {
    return kind === 'uploads';
  }
  return false;
}

function entryIcon(kind: LibraryEntryKind): keyof typeof MaterialCommunityIcons.glyphMap {
  if (kind === 'album') {
    return 'album';
  }
  if (kind === 'artist') {
    return 'account-music';
  }
  if (kind === 'uploads') {
    return 'folder-music';
  }
  return 'playlist-music';
}

/**
 * Spotify-like library sidebar: compact controls, quick filters, search, and
 * dense media rows instead of embedding the full Library screen.
 */
export const LibrarySidebarExpanded: React.FC<LibrarySidebarExpandedProps> = ({
  displayMode,
  searchQuery,
  activeFilter,
  isFullscreen,
  onFullscreen,
  onCollapse,
  onSearchChange,
  onFilterChange,
  sortOrder,
  onSortOrderChange,
  playlists,
  savedAlbums,
  followedArtists,
  likedTracksCount,
  loading,
  error,
  onRetry,
}) => {
  const { t } = useTranslation();
  const router = useRouter();
  const theme = useTheme();
  const { isAuthenticated, canUsePrivateApi } = useOxy();
  // The listener's own uploads: private by construction, so a quick-access entry
  // of their own rather than a row mixed in with saved catalogue albums.
  const { total: uploadCount } = useUploads();

  const entries = useMemo<LibraryEntry[]>(() => {
    const likedSongs: LibraryEntry[] = isAuthenticated
      ? [{
          id: 'liked',
          kind: 'liked',
          title: t('library.likedSongs'),
          subtitle: `Playlist • ${likedTracksCount} ${likedTracksCount === 1 ? 'song' : 'songs'}`,
          href: '/library/liked',
          imageShape: 'square',
        }]
      : [];

    const uploadsEntry: LibraryEntry[] = isAuthenticated && uploadCount > 0
      ? [{
          id: 'uploads',
          kind: 'uploads',
          title: t('uploads.locker.title'),
          subtitle: t('uploads.locker.trackCount', { count: uploadCount }),
          href: '/library/uploads',
          imageShape: 'square',
        }]
      : [];

    const playlistEntries = playlists.map<LibraryEntry>((playlist) => ({
      id: playlist.id,
      kind: 'playlist',
      title: playlist.name,
      subtitle: `${playlist.visibility === 'public' ? 'Public playlist' : 'Private playlist'} • ${playlist.trackCount || 0} ${playlist.trackCount === 1 ? 'song' : 'songs'}`,
      href: { pathname: '/playlist/[id]', params: { id: playlist.id } },
      imageUrl: pickCatalogImageUrl(undefined, playlist.coverArt, 'thumbnail', playlist.coverArtSizes),
      imageShape: 'square',
    }));

    const artistEntries = followedArtists.map<LibraryEntry>((artist) => ({
      id: artist.id,
      kind: 'artist',
      title: artist.name,
      subtitle: t('common.artist'),
      href: { pathname: '/p/[id]', params: { id: artist.id } },
      imageUrl: pickCatalogImageUrl(artist.images, artist.image, 'thumbnail', artist.imageSizes),
      imageShape: 'circle',
    }));

    const albumEntries = savedAlbums.map<LibraryEntry>((album) => ({
      id: album.id,
      kind: 'album',
      title: album.title,
      subtitle: `${album.artistName}${album.releaseDate ? ` • ${new Date(album.releaseDate).getFullYear()}` : ''}`,
      href: { pathname: '/album/[id]', params: { id: album.id } },
      imageUrl: pickCatalogImageUrl(undefined, album.coverArt, 'thumbnail', album.coverArtSizes),
      imageShape: 'square',
    }));

    const normalizedSearch = searchQuery.trim().toLowerCase();
    // `type` order is this concatenation itself: liked songs, then playlists,
    // artists and albums.
    const visible = [...likedSongs, ...uploadsEntry, ...playlistEntries, ...artistEntries, ...albumEntries].filter((entry) => {
      if (!filterAllowsEntry(activeFilter, entry.kind)) {
        return false;
      }
      if (!normalizedSearch) {
        return true;
      }
      return `${entry.title} ${entry.subtitle}`.toLowerCase().includes(normalizedSearch);
    });

    if (sortOrder === 'alphabetical') {
      // Sort a copy: `visible` is about to be memoized and must not be mutated.
      return [...visible].sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
      );
    }
    return visible;
  }, [
    activeFilter,
    followedArtists,
    isAuthenticated,
    likedTracksCount,
    playlists,
    savedAlbums,
    searchQuery,
    sortOrder,
    t,
    uploadCount,
  ]);

  const isGrid = displayMode === 'grid';

  return (
    // Match the collapsed view, whose transparent container shows the wrapping
    // Panel's `surface` color (`backgroundSecondary`); use that same token here
    // instead of the darker app `background` so both views read identically.
    <View className="flex-1 h-full pt-2.5 bg-surface">
      <View className="flex-row items-center justify-between px-3 mb-3">
        <View className="flex-row items-center gap-2 min-w-0">
          <Pressable
            onPress={onCollapse}
            className="w-8 h-8 items-center justify-center rounded-[16px] web:cursor-pointer"
            accessibilityRole="button"
            accessibilityLabel={t('sidebar.collapse')}
          >
            <Octicons name="sidebar-collapse" size={19} color={theme.colors.textSecondary} />
          </Pressable>
          <Text className="text-[16px] font-extrabold text-foreground">{t('library.title')}</Text>
        </View>

        <View className="flex-row items-center gap-1">
          {canUsePrivateApi && (
            <Pressable
              onPress={() => router.push('/create-playlist')}
              className="w-8 h-8 items-center justify-center rounded-[16px] web:cursor-pointer"
              accessibilityRole="button"
              accessibilityLabel={t('sidebar.createPlaylist')}
            >
              <Ionicons name="add" size={22} color={theme.colors.textSecondary} />
            </Pressable>
          )}
          <Pressable
            onPress={onFullscreen}
            className="w-8 h-8 items-center justify-center rounded-[16px] web:cursor-pointer"
            accessibilityRole="button"
            accessibilityLabel={isFullscreen ? 'Exit fullscreen library' : 'Expand library'}
          >
            <Ionicons
              name={isFullscreen ? 'contract' : 'expand'}
              size={18}
              color={theme.colors.textSecondary}
            />
          </Pressable>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2 px-3"
        className="grow-0 mb-2.5"
      >
        {FILTERS.map((filter) => {
          const isActive = activeFilter === filter;
          return (
            <Pressable
              key={filter}
              onPress={() => onFilterChange(filter)}
              className={cn(
                'h-[30px] px-3 items-center justify-center rounded-[15px]',
                isActive ? 'bg-foreground' : 'bg-popover',
              )}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
            >
              <Text
                className={cn(
                  'text-[13px] font-bold',
                  isActive ? 'text-background' : 'text-foreground',
                )}
              >
                {filter}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View className="flex-row items-center gap-2 px-3 mb-2.5">
        {/* Bloom's Search rather than a hand-rolled box: it carries the pill
            field, the magnifying glass and the clear button, and it tracks the
            design system when that changes. `label` doubles as the placeholder,
            and clearing is a real control instead of the user deleting
            character by character. */}
        <View className="flex-1 h-[34px] flex-row items-center gap-2 rounded-[6px] px-2.5 min-w-0">
          <Search
            value={searchQuery}
            onChangeText={onSearchChange}
            label={t('sidebar.searchPlaceholder')}
            onClearText={() => onSearchChange('')}
          />
        </View>
        {/* Two orders, so the control is a toggle rather than a menu — the
            label always names the order currently applied. It deliberately does
            NOT offer "Recents" or "Recently added": library membership carries
            no per-user timestamp, so neither can be derived honestly here. */}
        <Pressable
          className="h-[34px] flex-row items-center gap-1.5 web:cursor-pointer"
          onPress={() => onSortOrderChange(sortOrder === 'type' ? 'alphabetical' : 'type')}
          accessibilityRole="button"
          accessibilityLabel={
            sortOrder === 'alphabetical'
              ? 'Sorted A to Z. Activate to group by type.'
              : 'Grouped by type. Activate to sort A to Z.'
          }
        >
          <Text className="text-[12px] font-bold text-muted-foreground">
            {sortOrder === 'alphabetical' ? 'A–Z' : 'By type'}
          </Text>
          <Ionicons
            name={sortOrder === 'alphabetical' ? 'text' : 'list'}
            size={18}
            color={theme.colors.textSecondary}
          />
        </Pressable>
      </View>

      {loading && isAuthenticated ? (
        <View className="flex-1 items-center justify-center gap-2.5 p-[18px]">
          <ActivityIndicator size="small" color={theme.colors.primary} />
        </View>
      ) : error ? (
        <EmptyState
          icon={{ name: 'alert-circle-outline', size: 28 }}
          error={{
            title: t('sidebar.loadError'),
            message: error,
            onRetry,
          }}
          containerStyle={styles.stateContainer}
        />
      ) : !isAuthenticated ? (
        <EmptyState
          icon={{ name: 'lock-closed-outline', size: 28 }}
          subtitle={t('library.signedOut')}
          containerStyle={styles.stateContainer}
        />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={{ name: 'musical-notes-outline', size: 28 }}
          subtitle={t('sidebar.noItems')}
          containerStyle={styles.stateContainer}
        />
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerClassName={cn('px-2 pb-3', isGrid && 'flex-row flex-wrap gap-2 px-3')}
          showsVerticalScrollIndicator={false}
        >
          {entries.map((entry) => (
            <Pressable
              key={`${entry.kind}-${entry.id}`}
              onPress={() => router.push(entry.href)}
              className={cn(
                'min-h-[58px] flex-row items-center gap-2.5 px-1.5 rounded-[6px] web:cursor-pointer',
                isGrid && 'w-[172px] min-h-[76px]',
              )}
              accessibilityRole="button"
            >
              <View
                className={cn(
                  'w-[46px] h-[46px] rounded-[4px] items-center justify-center overflow-hidden',
                  entry.imageShape === 'circle' && 'rounded-[23px]',
                  entry.kind === 'liked' ? 'bg-primary' : 'bg-popover',
                )}
              >
                {entry.imageUrl ? (
                  <Image
                    source={{ uri: entry.imageUrl }}
                    style={entry.imageShape === 'circle' ? styles.circleArtworkImage : styles.artworkImage}
                    contentFit="cover"
                  />
                ) : entry.kind === 'liked' ? (
                  <Ionicons name="heart" size={22} color={theme.colors.primaryForeground} />
                ) : (
                  <MaterialCommunityIcons
                    name={entryIcon(entry.kind)}
                    size={22}
                    color={theme.colors.textSecondary}
                  />
                )}
              </View>
              <View className="flex-1 min-w-0">
                <Text className="text-[14px] font-bold mb-[3px] text-foreground" numberOfLines={1}>
                  {entry.title}
                </Text>
                <Text className="text-[12px] font-medium text-muted-foreground" numberOfLines={1}>
                  {entry.subtitle}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
};

// The only styles left are the ones no NativeWind class can reach: `expo-image`
// has no `className` prop, and `EmptyState` takes a `ViewStyle` through
// `containerStyle` rather than a class.
const styles = StyleSheet.create({
  artworkImage: {
    width: 46,
    height: 46,
  },
  circleArtworkImage: {
    width: 46,
    height: 46,
    borderRadius: 23,
  },
  // EmptyState paints the app background by default; the sidebar sits on the
  // panel surface, so let that colour show through.
  stateContainer: {
    paddingHorizontal: 18,
    backgroundColor: 'transparent',
  },
});
