import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons, Octicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { useOxy } from '@oxyhq/services';
import { Image } from 'expo-image';
import { Playlist, Album, Artist } from '@syra/shared-types';
import { pickCatalogImageUrl } from '@/utils/pickImage';

type LibraryFilter = 'All' | 'Playlists' | 'Artists' | 'Albums' | 'Podcasts';
type LibraryEntryKind = 'playlist' | 'liked' | 'artist' | 'album';

interface LibraryEntry {
  id: string;
  kind: LibraryEntryKind;
  title: string;
  subtitle: string;
  href: string;
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
  playlists: Playlist[];
  savedAlbums: Album[];
  followedArtists: Artist[];
  likedTracksCount: number;
  loading: boolean;
  error: string | null;
}

const FILTERS: LibraryFilter[] = ['All', 'Playlists', 'Artists', 'Albums', 'Podcasts'];

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
  return false;
}

function entryIcon(kind: LibraryEntryKind): keyof typeof MaterialCommunityIcons.glyphMap {
  if (kind === 'album') {
    return 'album';
  }
  if (kind === 'artist') {
    return 'account-music';
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
  playlists,
  savedAlbums,
  followedArtists,
  likedTracksCount,
  loading,
  error,
}) => {
  const router = useRouter();
  const theme = useTheme();
  const { isAuthenticated, canUsePrivateApi } = useOxy();

  const entries = useMemo<LibraryEntry[]>(() => {
    const likedSongs: LibraryEntry[] = isAuthenticated
      ? [{
          id: 'liked',
          kind: 'liked',
          title: 'Liked Songs',
          subtitle: `Playlist • ${likedTracksCount} ${likedTracksCount === 1 ? 'song' : 'songs'}`,
          href: '/library/liked',
          imageShape: 'square',
        }]
      : [];

    const playlistEntries = playlists.map<LibraryEntry>((playlist) => ({
      id: playlist.id,
      kind: 'playlist',
      title: playlist.name,
      subtitle: `${playlist.visibility === 'public' ? 'Public playlist' : 'Private playlist'} • ${playlist.trackCount || 0} ${playlist.trackCount === 1 ? 'song' : 'songs'}`,
      href: `/playlist/${playlist.id}`,
      imageUrl: pickCatalogImageUrl(undefined, playlist.coverArt, 'thumbnail', playlist.coverArtSizes),
      imageShape: 'square',
    }));

    const artistEntries = followedArtists.map<LibraryEntry>((artist) => ({
      id: artist.id,
      kind: 'artist',
      title: artist.name,
      subtitle: 'Artist',
      href: `/artist/${artist.id}`,
      imageUrl: pickCatalogImageUrl(artist.images, artist.image, 'thumbnail', artist.imageSizes),
      imageShape: 'circle',
    }));

    const albumEntries = savedAlbums.map<LibraryEntry>((album) => ({
      id: album.id,
      kind: 'album',
      title: album.title,
      subtitle: `${album.artistName}${album.releaseDate ? ` • ${new Date(album.releaseDate).getFullYear()}` : ''}`,
      href: `/album/${album.id}`,
      imageUrl: pickCatalogImageUrl(undefined, album.coverArt, 'thumbnail', album.coverArtSizes),
      imageShape: 'square',
    }));

    const normalizedSearch = searchQuery.trim().toLowerCase();
    return [...likedSongs, ...playlistEntries, ...artistEntries, ...albumEntries].filter((entry) => {
      if (!filterAllowsEntry(activeFilter, entry.kind)) {
        return false;
      }
      if (!normalizedSearch) {
        return true;
      }
      return `${entry.title} ${entry.subtitle}`.toLowerCase().includes(normalizedSearch);
    });
  }, [
    activeFilter,
    followedArtists,
    isAuthenticated,
    likedTracksCount,
    playlists,
    savedAlbums,
    searchQuery,
  ]);

  const isGrid = displayMode === 'grid';

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Pressable
            onPress={onCollapse}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="Collapse library"
          >
            <Octicons name="sidebar-collapse" size={19} color={theme.colors.textSecondary} />
          </Pressable>
          <Text style={[styles.title, { color: theme.colors.text }]}>Your Library</Text>
        </View>

        <View style={styles.headerActions}>
          {canUsePrivateApi && (
            <Pressable
              onPress={() => router.push('/create-playlist')}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="Create playlist"
            >
              <Ionicons name="add" size={22} color={theme.colors.textSecondary} />
            </Pressable>
          )}
          <Pressable
            onPress={onFullscreen}
            style={styles.iconButton}
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
        contentContainerStyle={styles.filterContent}
        style={styles.filterScroll}
      >
        {FILTERS.map((filter) => {
          const isActive = activeFilter === filter;
          return (
            <Pressable
              key={filter}
              onPress={() => onFilterChange(filter)}
              style={[
                styles.filterButton,
                { backgroundColor: isActive ? theme.colors.text : theme.colors.backgroundTertiary },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
            >
              <Text
                style={[
                  styles.filterText,
                  { color: isActive ? theme.colors.background : theme.colors.text },
                ]}
              >
                {filter}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.toolRow}>
        <View style={[styles.searchBox, { backgroundColor: theme.colors.backgroundTertiary }]}>
          <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
          <TextInput
            value={searchQuery}
            onChangeText={onSearchChange}
            placeholder="Search in Your Library"
            placeholderTextColor={theme.colors.textSecondary}
            style={[styles.searchInput, { color: theme.colors.text }]}
          />
        </View>
        <Pressable style={styles.sortButton} accessibilityRole="button" accessibilityLabel="Sort library">
          <Text style={[styles.sortText, { color: theme.colors.textSecondary }]}>Recents</Text>
          <Ionicons name="list" size={18} color={theme.colors.textSecondary} />
        </Pressable>
      </View>

      {loading && isAuthenticated ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.centerState}>
          <MaterialCommunityIcons name="alert-circle-outline" size={28} color={theme.colors.textSecondary} />
          <Text style={[styles.stateText, { color: theme.colors.textSecondary }]}>{error}</Text>
        </View>
      ) : !isAuthenticated ? (
        <View style={styles.centerState}>
          <MaterialCommunityIcons name="lock-outline" size={28} color={theme.colors.textSecondary} />
          <Text style={[styles.stateText, { color: theme.colors.textSecondary }]}>Sign in to view your library</Text>
        </View>
      ) : entries.length === 0 ? (
        <View style={styles.centerState}>
          <MaterialCommunityIcons name="music-box-multiple-outline" size={28} color={theme.colors.textSecondary} />
          <Text style={[styles.stateText, { color: theme.colors.textSecondary }]}>No items found</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.entriesScroll}
          contentContainerStyle={[styles.entriesContent, isGrid && styles.gridContent]}
          showsVerticalScrollIndicator={false}
        >
          {entries.map((entry) => (
            <Pressable
              key={`${entry.kind}-${entry.id}`}
              onPress={() => router.push(entry.href)}
              style={[styles.entryRow, isGrid && styles.gridEntry]}
              accessibilityRole="button"
            >
              <View
                style={[
                  styles.artwork,
                  entry.imageShape === 'circle' && styles.circleArtwork,
                  { backgroundColor: entry.kind === 'liked' ? theme.colors.primary : theme.colors.backgroundTertiary },
                ]}
              >
                {entry.imageUrl ? (
                  <Image
                    source={{ uri: entry.imageUrl }}
                    style={[styles.artworkImage, entry.imageShape === 'circle' && styles.circleArtwork]}
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
              <View style={styles.entryText}>
                <Text style={[styles.entryTitle, { color: theme.colors.text }]} numberOfLines={1}>
                  {entry.title}
                </Text>
                <Text style={[styles.entrySubtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    height: '100%',
    paddingTop: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  title: {
    fontSize: 16,
    fontWeight: '800',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  iconButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  filterScroll: {
    flexGrow: 0,
    marginBottom: 10,
  },
  filterContent: {
    gap: 8,
    paddingHorizontal: 12,
  },
  filterButton: {
    height: 30,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
  },
  filterText: {
    fontSize: 13,
    fontWeight: '700',
  },
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    marginBottom: 10,
  },
  searchBox: {
    flex: 1,
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 6,
    paddingHorizontal: 10,
    minWidth: 0,
  },
  searchInput: {
    flex: 1,
    height: 34,
    fontSize: 13,
    paddingVertical: 0,
  },
  sortButton: {
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  sortText: {
    fontSize: 12,
    fontWeight: '700',
  },
  entriesScroll: {
    flex: 1,
  },
  entriesContent: {
    paddingHorizontal: 8,
    paddingBottom: 12,
  },
  gridContent: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 12,
  },
  entryRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 6,
    borderRadius: 6,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  gridEntry: {
    width: 172,
    minHeight: 76,
  },
  artwork: {
    width: 46,
    height: 46,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  circleArtwork: {
    borderRadius: 23,
  },
  artworkImage: {
    width: 46,
    height: 46,
  },
  entryText: {
    flex: 1,
    minWidth: 0,
  },
  entryTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 3,
  },
  entrySubtitle: {
    fontSize: 12,
    fontWeight: '500',
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 18,
  },
  stateText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});
