import React from 'react';
import { StyleSheet, View, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons, Octicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Playlist, Album, Artist } from '@syra/shared-types';
import { Image } from 'expo-image';
import { useOxy } from '@oxyhq/services';
import { pickCatalogImageUrl } from '@/utils/pickImage';

interface LibrarySidebarCollapsedProps {
  onExpand: () => void;
  playlists: Playlist[];
  savedAlbums: Album[];
  followedArtists: Artist[];
  likedTracksCount: number;
  loading: boolean;
  /** Library load failure, surfaced as a tap-to-retry indicator in the rail. */
  error?: string | null;
  /** Re-arms the auth gate and refetches the library queries behind these props. */
  onRetry: () => Promise<void>;
}

/**
 * Library Sidebar Collapsed View
 * Compact icon-only sidebar showing liked songs and playlists
 */
export const LibrarySidebarCollapsed: React.FC<LibrarySidebarCollapsedProps> = ({ 
  onExpand,
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
  const { isAuthenticated } = useOxy();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          onPress={onExpand}
          style={styles.expandButton}
          accessibilityRole="button"
          accessibilityLabel={t('sidebar.expandAccessibility')}
        >
          <Octicons
            name="sidebar-expand"
            size={18}
            color={theme.colors.text}
          />
        </Pressable>
      </View>

      <ScrollView 
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Liked Songs */}
        {isAuthenticated && (
          <Pressable
            style={[styles.iconButton, { backgroundColor: theme.colors.primary }]}
            onPress={() => router.push('/library/liked')}
          >
            <Ionicons name="heart" size={18} color={theme.colors.primaryForeground} />
          </Pressable>
        )}

        {/* Loading state */}
        {loading && isAuthenticated && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color={theme.colors.primary} />
          </View>
        )}

        {/* Load failure. The rail is too narrow for a message, so it shows a
            tappable marker that retries — never an empty-looking rail. The
            retry flips the shared hook back to `loading`, which renders the
            spinner above, so no local pending state is needed here. */}
        {!loading && isAuthenticated && error && (
          <Pressable
            style={styles.iconButton}
            onPress={() => { void onRetry(); }}
            accessibilityRole="button"
            accessibilityLabel={`Library unavailable: ${error}. Tap to retry.`}
          >
            <MaterialCommunityIcons
              name="alert-circle-outline"
              size={20}
              color={theme.colors.error}
            />
          </Pressable>
        )}

        {/* Nothing saved yet — same tap-to-expand treatment as the error marker. */}
        {!loading && isAuthenticated && !error
          && playlists.length === 0
          && followedArtists.length === 0
          && savedAlbums.length === 0 && (
          <Pressable
            style={styles.iconButton}
            onPress={onExpand}
            accessibilityRole="button"
            accessibilityLabel={t('sidebar.emptyCollapsed')}
          >
            <MaterialCommunityIcons
              name="music-box-multiple-outline"
              size={20}
              color={theme.colors.textSecondary}
            />
          </Pressable>
        )}

        {/* Playlists */}
        {!loading && !error && isAuthenticated && playlists.map((playlist) => (
          <Pressable
            key={playlist.id}
            style={styles.iconButton}
            onPress={() => router.push(`/playlist/${playlist.id}`)}
          >
            {playlist.coverArt ? (
              <Image
                source={{ uri: pickCatalogImageUrl(undefined, playlist.coverArt, 'icon', playlist.coverArtSizes) }}
                style={styles.playlistIcon}
                contentFit="cover"
              />
            ) : (
              <View style={[styles.playlistIconPlaceholder, { backgroundColor: theme.colors.backgroundTertiary }]}>
                <MaterialCommunityIcons
                  name="playlist-music"
                  size={18}
                  color={theme.colors.textSecondary}
                />
              </View>
            )}
          </Pressable>
        ))}

        {/* Artists */}
        {!loading && !error && isAuthenticated && followedArtists.map((artist) => (
          <Pressable
            key={artist.id}
            style={styles.iconButton}
            onPress={() => router.push(`/p/${artist.id}`)}
          >
            {(artist.image || artist.images?.length) ? (
              <Image
                source={{ uri: pickCatalogImageUrl(artist.images, artist.image, 'icon', artist.imageSizes) }}
                style={styles.artistIcon}
                contentFit="cover"
              />
            ) : (
              <View style={[styles.artistIconPlaceholder, { backgroundColor: theme.colors.backgroundTertiary }]}>
                <Ionicons
                  name="person"
                  size={18}
                  color={theme.colors.textSecondary}
                />
              </View>
            )}
          </Pressable>
        ))}

        {/* Albums */}
        {!loading && !error && isAuthenticated && savedAlbums.map((album) => (
          <Pressable
            key={album.id}
            style={styles.iconButton}
            onPress={() => router.push(`/album/${album.id}`)}
          >
            {album.coverArt ? (
              <Image
                source={{ uri: pickCatalogImageUrl(undefined, album.coverArt, 'icon', album.coverArtSizes) }}
                style={styles.playlistIcon}
                contentFit="cover"
              />
            ) : (
              <View style={[styles.playlistIconPlaceholder, { backgroundColor: theme.colors.backgroundTertiary }]}>
                <MaterialCommunityIcons
                  name="album"
                  size={18}
                  color={theme.colors.textSecondary}
                />
              </View>
            )}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    padding: 8,
  },
  header: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  expandButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  scrollView: {
    flex: 1,
    width: '100%',
  },
  scrollContent: {
    alignItems: 'center',
    gap: 8,
    paddingBottom: 8,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playlistIcon: {
    width: 40,
    height: 40,
    borderRadius: 4,
  },
  playlistIconPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artistIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  artistIconPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingContainer: {
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
