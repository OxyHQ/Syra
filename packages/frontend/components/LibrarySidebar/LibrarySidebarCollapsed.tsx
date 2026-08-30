import React from 'react';
import { StyleSheet, View, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import Octicons from '@expo/vector-icons/Octicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Playlist, Album, Artist } from '@syra/shared-types';
import { Image } from 'expo-image';
import { useOxy } from '@oxyhq/services';
import { useMyPodcasts, useSubscriptions } from '@/hooks/usePodcasts';
import { pickCatalogImageUrl, resolvePodcastArtwork } from '@/utils/pickImage';

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
  /**
   * Read here rather than threaded through `LibrarySidebar`, matching the
   * expanded view: both are shared React Query keys, so a second consumer costs
   * no second request.
   *
   * The rail has to carry them for the same reason the expanded view does —
   * collapsing the sidebar must not be a way to lose your podcasts — and they
   * count toward the "nothing saved yet" marker below, which otherwise tells a
   * listener with subscriptions that their library is empty.
   */
  const subscribedPodcasts = useSubscriptions().data?.subscriptions ?? [];
  const myPodcasts = useMyPodcasts().data ?? [];

  return (
    <View className="flex-1 items-center justify-start p-2">
      <View className="w-full items-center justify-center mb-2">
        <Pressable
          onPress={onExpand}
          className="w-7 h-7 items-center justify-center rounded-[14px]"
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
        className="flex-1 w-full"
        contentContainerClassName="items-center gap-2 pb-2"
        showsVerticalScrollIndicator={false}
      >
        {/* Liked Songs */}
        {isAuthenticated && (
          <Pressable
            className="w-10 h-10 rounded-[4px] items-center justify-center bg-primary"
            onPress={() => router.push('/library/liked')}
          >
            <Ionicons name="heart" size={18} color={theme.colors.primaryForeground} />
          </Pressable>
        )}

        {/* Loading state */}
        {loading && isAuthenticated && (
          <View className="p-2 items-center justify-center">
            <ActivityIndicator size="small" color={theme.colors.primary} />
          </View>
        )}

        {/* Load failure. The rail is too narrow for a message, so it shows a
            tappable marker that retries — never an empty-looking rail. The
            retry flips the shared hook back to `loading`, which renders the
            spinner above, so no local pending state is needed here. */}
        {!loading && isAuthenticated && error && (
          <Pressable
            className="w-10 h-10 rounded-[4px] items-center justify-center"
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
          && savedAlbums.length === 0
          && subscribedPodcasts.length === 0
          && myPodcasts.length === 0 && (
          <Pressable
            className="w-10 h-10 rounded-[4px] items-center justify-center"
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
            className="w-10 h-10 rounded-[4px] items-center justify-center"
            onPress={() => router.push(`/playlist/${playlist.id}`)}
          >
            {playlist.coverArt ? (
              <Image
                source={{ uri: pickCatalogImageUrl(undefined, playlist.coverArt, 'icon', playlist.coverArtSizes) }}
                style={styles.squareIcon}
                contentFit="cover"
              />
            ) : (
              <View className="w-10 h-10 rounded-[4px] items-center justify-center bg-popover">
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
            className="w-10 h-10 rounded-[4px] items-center justify-center"
            onPress={() => router.push(`/p/${artist.id}`)}
          >
            {(artist.image || artist.images?.length) ? (
              <Image
                source={{ uri: pickCatalogImageUrl(artist.images, artist.image, 'icon', artist.imageSizes) }}
                style={styles.roundIcon}
                contentFit="cover"
              />
            ) : (
              <View className="w-10 h-10 rounded-[20px] items-center justify-center bg-popover">
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
            className="w-10 h-10 rounded-[4px] items-center justify-center"
            onPress={() => router.push(`/album/${album.id}`)}
          >
            {album.coverArt ? (
              <Image
                source={{ uri: pickCatalogImageUrl(undefined, album.coverArt, 'icon', album.coverArtSizes) }}
                style={styles.squareIcon}
                contentFit="cover"
              />
            ) : (
              <View className="w-10 h-10 rounded-[4px] items-center justify-center bg-popover">
                <MaterialCommunityIcons
                  name="album"
                  size={18}
                  color={theme.colors.textSecondary}
                />
              </View>
            )}
          </Pressable>
        ))}

        {/* Subscribed podcasts, then the viewer's OWN shows — the same order the
            expanded view concatenates them in, so the rail and the list do not
            disagree about where a show sits. The keys carry the relationship
            because a creator subscribed to their own show appears in both, and
            two rows keyed on the id alone would collide. */}
        {!loading && !error && isAuthenticated && subscribedPodcasts.map(({ podcast }) => (
          <Pressable
            key={`podcast-${podcast.id}`}
            className="w-10 h-10 rounded-[4px] items-center justify-center"
            onPress={() => router.push({ pathname: '/podcasts/[id]', params: { id: podcast.id } })}
          >
            {resolvePodcastArtwork(podcast, 'icon') ? (
              <Image
                source={{ uri: resolvePodcastArtwork(podcast, 'icon') }}
                style={styles.squareIcon}
                contentFit="cover"
              />
            ) : (
              <View className="w-10 h-10 rounded-[4px] items-center justify-center bg-popover">
                <MaterialCommunityIcons
                  name="podcast"
                  size={18}
                  color={theme.colors.textSecondary}
                />
              </View>
            )}
          </Pressable>
        ))}

        {!loading && !error && isAuthenticated && myPodcasts.map((podcast) => (
          <Pressable
            key={`show-${podcast.id}`}
            className="w-10 h-10 rounded-[4px] items-center justify-center"
            onPress={() => router.push({ pathname: '/podcasts/[id]', params: { id: podcast.id } })}
          >
            {resolvePodcastArtwork(podcast, 'icon') ? (
              <Image
                source={{ uri: resolvePodcastArtwork(podcast, 'icon') }}
                style={styles.squareIcon}
                contentFit="cover"
              />
            ) : (
              <View className="w-10 h-10 rounded-[4px] items-center justify-center bg-popover">
                <MaterialCommunityIcons
                  name="podcast"
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

// `expo-image` has no `className` prop, so the artwork sizing stays a style.
const styles = StyleSheet.create({
  squareIcon: {
    width: 40,
    height: 40,
    borderRadius: 4,
  },
  roundIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
});
