import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, ScrollView, Pressable, Platform, ActivityIndicator } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import SEO from '@/components/SEO';
import { Ionicons, Octicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import { Playlist, Album, Artist } from '@syra/shared-types';
import { musicService } from '@/services/musicService';
import { libraryService } from '@/services/libraryService';
import { Image } from 'expo-image';

interface LibraryScreenProps {
  // Optional props for sidebar mode
  showSidebarControls?: boolean;
  isFullscreen?: boolean;
  onFullscreen?: () => void;
  onCollapse?: () => void;
  // Optional data props - if provided, use them instead of fetching
  playlists?: Playlist[];
  savedAlbums?: Album[];
  followedArtists?: Artist[];
  likedTracksCount?: number;
  loading?: boolean;
  error?: string | null;
}

/**
 * Musico Library Screen
 * User's music library (Liked Songs, Playlists, Artists, Albums)
 * Can be used as standalone screen or as sidebar component
 */
const LibraryScreen: React.FC<LibraryScreenProps> = ({
  showSidebarControls = false,
  isFullscreen = false,
  onFullscreen,
  onCollapse,
  playlists: propsPlaylists,
  savedAlbums: propsSavedAlbums,
  followedArtists: propsFollowedArtists,
  likedTracksCount: propsLikedTracksCount,
  loading: propsLoading,
  error: propsError,
}) => {
  const theme = useTheme();
  const router = useRouter();
  const { isAuthenticated } = useOxy();

  // Filter state
  const [activeFilter, setActiveFilter] = useState<'Playlists' | 'Artists' | 'Albums' | 'All'>('All');

  // Use props if provided (sidebar mode), otherwise use local state (standalone mode)
  const isUsingProps = propsPlaylists !== undefined;
  
  // State management (only used in standalone mode)
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [savedAlbums, setSavedAlbums] = useState<Album[]>([]);
  const [followedArtists, setFollowedArtists] = useState<Artist[]>([]);
  const [likedTracksCount, setLikedTracksCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch library data (only in standalone mode when props are not provided)
  useEffect(() => {
    if (isUsingProps) {
      // Data is provided via props, no need to fetch
      return;
    }

    const fetchLibraryData = async () => {
      if (!isAuthenticated) {
        setLoading(false);
        setPlaylists([]);
        setLikedTracksCount(0);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        // Fetch all library data in parallel
        const [playlistsResponse, likedTracksResponse, libraryResponse] = await Promise.all([
          musicService.getUserPlaylists().catch((err) => {
            console.error('[LibraryScreen] Error fetching playlists:', err);
            return { playlists: [], total: 0 };
          }),
          libraryService.getLikedTracks().catch((err) => {
            console.error('[LibraryScreen] Error fetching liked tracks:', err);
            return { tracks: [], total: 0, oxyUserId: '' };
          }),
          libraryService.getUserLibrary().catch((err) => {
            console.error('[LibraryScreen] Error fetching library:', err);
            return { savedAlbums: [], followedArtists: [], likedTracks: [], oxyUserId: '' };
          }),
        ]);

        setPlaylists(playlistsResponse.playlists);
        setLikedTracksCount(likedTracksResponse.total);

        // Fetch full album and artist objects from IDs
        const albumPromises = (libraryResponse.savedAlbums || []).slice(0, 50).map((albumId: string) =>
          musicService.getAlbumById(albumId).catch(() => null)
        );
        const artistPromises = (libraryResponse.followedArtists || []).slice(0, 50).map((artistId: string) =>
          musicService.getArtistById(artistId).catch(() => null)
        );

        const [albums, artists] = await Promise.all([
          Promise.all(albumPromises),
          Promise.all(artistPromises),
        ]);

        setSavedAlbums(albums.filter((album): album is Album => album !== null));
        setFollowedArtists(artists.filter((artist): artist is Artist => artist !== null));
      } catch (err) {
        console.error('[LibraryScreen] Error fetching library data:', err);
        setError('Failed to load library data');
      } finally {
        setLoading(false);
      }
    };

    fetchLibraryData();
  }, [isAuthenticated, isUsingProps]);

  // Use props if provided, otherwise use local state
  const finalPlaylists = isUsingProps ? (propsPlaylists || []) : playlists;
  const finalSavedAlbums = isUsingProps ? (propsSavedAlbums || []) : savedAlbums;
  const finalFollowedArtists = isUsingProps ? (propsFollowedArtists || []) : followedArtists;
  const finalLikedTracksCount = isUsingProps ? (propsLikedTracksCount || 0) : likedTracksCount;
  const finalLoading = isUsingProps ? (propsLoading ?? false) : loading;
  const finalError = isUsingProps ? (propsError ?? null) : error;

  return (
    <>
      {!showSidebarControls && (
        <SEO
          title="Your Library - Musico"
          description="Your music library"
        />
      )}
      <ScrollView 
        style={[styles.container, { backgroundColor: theme.colors.background }]}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: theme.colors.text }]}>Your Library</Text>
          <View style={styles.headerActions}>
            <Pressable
              onPress={() => router.push('/create-playlist')}
              style={[styles.createButton, { backgroundColor: theme.colors.primary }]}
            >
              <MaterialCommunityIcons
                name="plus"
                size={18}
                color="#FFFFFF"
              />
              <Text style={styles.createButtonText}>Create Playlist</Text>
            </Pressable>
            {showSidebarControls && onFullscreen && (
              <Pressable
                onPress={onFullscreen}
                style={styles.headerButton}
              >
                <Ionicons
                  name={isFullscreen ? 'contract' : 'expand'}
                  size={18}
                  color={theme.colors.text}
                />
              </Pressable>
            )}
            {showSidebarControls && onCollapse && !isFullscreen && (
              <Pressable
                onPress={onCollapse}
                style={styles.headerButton}
              >
                <Octicons
                  name="sidebar-collapse"
                  size={18}
                  color={theme.colors.text}
                />
              </Pressable>
            )}
          </View>
        </View>

        {/* Filters */}
        <View style={styles.filters}>
          {['All', 'Playlists', 'Artists', 'Albums'].map((filter) => {
            const isActive = activeFilter === filter;
            return (
              <Pressable 
                key={filter}
                onPress={() => setActiveFilter(filter as 'Playlists' | 'Artists' | 'Albums' | 'All')}
                style={[
                  styles.filterButton,
                  { 
                    backgroundColor: isActive ? theme.colors.primary : theme.colors.backgroundSecondary 
                  }
                ]}
              >
                <Text style={[
                  styles.filterText, 
                  { 
                    color: isActive ? '#FFFFFF' : theme.colors.text,
                    fontWeight: isActive ? '700' : '600'
                  }
                ]}>
                  {filter}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Liked Songs - show only when All or Playlists filter is active */}
        {isAuthenticated && (activeFilter === 'All' || activeFilter === 'Playlists') && (
          <Pressable 
            style={[styles.libraryItem, { backgroundColor: theme.colors.backgroundSecondary }]}
            onPress={() => router.push('/library/liked')}
          >
            <View style={[styles.likedIcon, { backgroundColor: '#450af5' }]}>
              <Ionicons name="heart" size={24} color="#FFFFFF" />
            </View>
            <View style={styles.itemContent}>
              <Text style={[styles.itemTitle, { color: theme.colors.text }]}>Liked Songs</Text>
              <Text style={[styles.itemSubtitle, { color: theme.colors.textSecondary }]}>
                Playlist • {finalLoading ? '...' : `${finalLikedTracksCount} ${finalLikedTracksCount === 1 ? 'song' : 'songs'}`}
              </Text>
            </View>
          </Pressable>
        )}

        {/* Loading state */}
        {finalLoading && isAuthenticated && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
              Loading your library...
            </Text>
          </View>
        )}

        {/* Error state */}
        {finalError && !finalLoading && (
          <View style={styles.emptyState}>
            <MaterialCommunityIcons
              name="alert-circle-outline"
              size={48}
              color={theme.colors.textSecondary}
              style={styles.emptyIcon}
            />
            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
              {finalError}
            </Text>
          </View>
        )}

        {/* Playlists list */}
        {!finalLoading && !finalError && finalPlaylists.length > 0 && (activeFilter === 'All' || activeFilter === 'Playlists') && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Playlists</Text>
            <View style={styles.itemsContainer}>
              {finalPlaylists.map((playlist) => (
                <Pressable
                  key={playlist.id}
                  style={[styles.libraryItem, { backgroundColor: theme.colors.backgroundSecondary }]}
                  onPress={() => router.push(`/playlist/${playlist.id}`)}
                >
                  {playlist.coverArt ? (
                    <Image
                      source={{ uri: playlist.coverArt }}
                      style={styles.playlistImage}
                      contentFit="cover"
                    />
                  ) : (
                    <View style={[styles.playlistImagePlaceholder, { backgroundColor: theme.colors.background }]}>
                      <MaterialCommunityIcons
                        name="playlist-music"
                        size={24}
                        color={theme.colors.textSecondary}
                      />
                    </View>
                  )}
                  <View style={styles.itemContent}>
                    <Text style={[styles.itemTitle, { color: theme.colors.text }]} numberOfLines={1}>
                      {playlist.name}
                    </Text>
                    <Text style={[styles.itemSubtitle, { color: theme.colors.textSecondary }]}>
                      {playlist.visibility === 'public' ? 'Public' : 'Private'} • {playlist.trackCount || 0} {playlist.trackCount === 1 ? 'song' : 'songs'}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Artists list */}
        {!finalLoading && !finalError && finalFollowedArtists.length > 0 && (activeFilter === 'All' || activeFilter === 'Artists') && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Artists</Text>
            <View style={styles.itemsContainer}>
              {finalFollowedArtists.map((artist) => (
                <Pressable
                  key={artist.id}
                  style={[styles.libraryItem, { backgroundColor: theme.colors.backgroundSecondary }]}
                  onPress={() => router.push(`/artist/${artist.id}`)}
                >
                  {artist.profileImage ? (
                    <Image
                      source={{ uri: artist.profileImage }}
                      style={styles.artistImage}
                      contentFit="cover"
                    />
                  ) : (
                    <View style={[styles.artistImagePlaceholder, { backgroundColor: theme.colors.background }]}>
                      <Ionicons
                        name="person"
                        size={24}
                        color={theme.colors.textSecondary}
                      />
                    </View>
                  )}
                  <View style={styles.itemContent}>
                    <Text style={[styles.itemTitle, { color: theme.colors.text }]} numberOfLines={1}>
                      {artist.name}
                    </Text>
                    <Text style={[styles.itemSubtitle, { color: theme.colors.textSecondary }]}>
                      Artist
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Albums list */}
        {!finalLoading && !finalError && finalSavedAlbums.length > 0 && (activeFilter === 'All' || activeFilter === 'Albums') && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Albums</Text>
            <View style={styles.itemsContainer}>
              {finalSavedAlbums.map((album) => (
                <Pressable
                  key={album.id}
                  style={[styles.libraryItem, { backgroundColor: theme.colors.backgroundSecondary }]}
                  onPress={() => router.push(`/album/${album.id}`)}
                >
                  {album.coverArt ? (
                    <Image
                      source={{ uri: album.coverArt }}
                      style={styles.playlistImage}
                      contentFit="cover"
                    />
                  ) : (
                    <View style={[styles.playlistImagePlaceholder, { backgroundColor: theme.colors.background }]}>
                      <MaterialCommunityIcons
                        name="album"
                        size={24}
                        color={theme.colors.textSecondary}
                      />
                    </View>
                  )}
                  <View style={styles.itemContent}>
                    <Text style={[styles.itemTitle, { color: theme.colors.text }]} numberOfLines={1}>
                      {album.name}
                    </Text>
                    <Text style={[styles.itemSubtitle, { color: theme.colors.textSecondary }]}>
                      {album.artistName} • {album.releaseYear || ''}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Empty state - show based on active filter */}
        {!finalLoading && !finalError && isAuthenticated && (
          (activeFilter === 'All' && finalPlaylists.length === 0 && finalFollowedArtists.length === 0 && finalSavedAlbums.length === 0) ||
          (activeFilter === 'Playlists' && finalPlaylists.length === 0) ||
          (activeFilter === 'Artists' && finalFollowedArtists.length === 0) ||
          (activeFilter === 'Albums' && finalSavedAlbums.length === 0)
        ) && (
          <View style={styles.emptyState}>
            <MaterialCommunityIcons
              name="playlist-music"
              size={48}
              color={theme.colors.textSecondary}
              style={styles.emptyIcon}
            />
            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
              {activeFilter === 'All' && 'Your library is empty'}
              {activeFilter === 'Playlists' && 'No playlists yet'}
              {activeFilter === 'Artists' && 'No followed artists yet'}
              {activeFilter === 'Albums' && 'No saved albums yet'}
            </Text>
            {activeFilter === 'Playlists' && (
              <Pressable
                onPress={() => router.push('/create-playlist')}
                style={[styles.emptyCreateButton, { backgroundColor: theme.colors.primary }]}
              >
                <Text style={styles.emptyCreateButtonText}>Create your first playlist</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Not authenticated state */}
        {!isAuthenticated && !finalLoading && (
          <View style={styles.emptyState}>
            <MaterialCommunityIcons
              name="lock-outline"
              size={48}
              color={theme.colors.textSecondary}
              style={styles.emptyIcon}
            />
            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
              Sign in to view your library
            </Text>
          </View>
        )}
      </ScrollView>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    padding: 12,
    paddingBottom: 100,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  createButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  headerButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  filters: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
    alignItems: 'center',
  },
  filterButton: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  filterText: {
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 13,
  },
  libraryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 8,
    borderRadius: 6,
    marginBottom: 8,
  },
  likedIcon: {
    width: 48,
    height: 48,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemContent: {
    flex: 1,
  },
  itemTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  itemSubtitle: {
    fontSize: 12,
  },
  emptyState: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyIcon: {
    opacity: 0.5,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
  emptyCreateButton: {
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  emptyCreateButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  loadingContainer: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    textAlign: 'center',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  itemsContainer: {
    gap: 0,
  },
  playlistImage: {
    width: 48,
    height: 48,
    borderRadius: 4,
  },
  playlistImagePlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artistImage: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  artistImagePlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default LibraryScreen;

