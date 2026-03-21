import React from 'react';
import { StyleSheet, View, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons, Octicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { Playlist, Album, Artist } from '@syra/shared-types';
import { Image } from 'expo-image';
import { useOxy } from '@oxyhq/services';

interface LibrarySidebarCollapsedProps {
  onExpand: () => void;
  playlists: Playlist[];
  savedAlbums: Album[];
  followedArtists: Artist[];
  likedTracksCount: number;
  loading: boolean;
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
}) => {
  const router = useRouter();
  const theme = useTheme();
  const { isAuthenticated } = useOxy();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          onPress={onExpand}
          style={styles.expandButton}
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
            style={[styles.iconButton, { backgroundColor: '#450af5' }]}
            onPress={() => router.push('/library/liked')}
          >
            <Ionicons name="heart" size={18} color="#FFFFFF" />
          </Pressable>
        )}

        {/* Loading state */}
        {loading && isAuthenticated && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color={theme.colors.primary} />
          </View>
        )}

        {/* Playlists */}
        {!loading && isAuthenticated && playlists.map((playlist) => (
          <Pressable
            key={playlist.id}
            style={styles.iconButton}
            onPress={() => router.push(`/playlist/${playlist.id}`)}
          >
            {playlist.coverArt ? (
              <Image
                source={{ uri: playlist.coverArt }}
                style={styles.playlistIcon}
                contentFit="cover"
              />
            ) : (
              <View style={[styles.playlistIconPlaceholder, { backgroundColor: theme.colors.backgroundSecondary }]}>
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
        {!loading && isAuthenticated && followedArtists.map((artist) => (
          <Pressable
            key={artist.id}
            style={styles.iconButton}
            onPress={() => router.push(`/artist/${artist.id}`)}
          >
            {artist.profileImage ? (
              <Image
                source={{ uri: artist.profileImage }}
                style={styles.artistIcon}
                contentFit="cover"
              />
            ) : (
              <View style={[styles.artistIconPlaceholder, { backgroundColor: theme.colors.backgroundSecondary }]}>
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
        {!loading && isAuthenticated && savedAlbums.map((album) => (
          <Pressable
            key={album.id}
            style={styles.iconButton}
            onPress={() => router.push(`/album/${album.id}`)}
          >
            {album.coverArt ? (
              <Image
                source={{ uri: album.coverArt }}
                style={styles.playlistIcon}
                contentFit="cover"
              />
            ) : (
              <View style={[styles.playlistIconPlaceholder, { backgroundColor: theme.colors.backgroundSecondary }]}>
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

